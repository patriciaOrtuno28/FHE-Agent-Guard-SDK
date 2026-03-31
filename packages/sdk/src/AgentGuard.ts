import type {
  AgentGuardConfig,
  ConnectorQuery,
  TrustScoreResult,
  GuardEventHandler,
  NormalizedFeatures,
  MergedFeatures,
  EncryptedFeatures,
} from "./types.js";

// ── BASE RANDOM FOREST ARTIFACT ───────────────────────────

const BASE_ARTIFACT = {
  modelId: "base-anomaly-rf-v1",
  version: "1.0.0",
  circuitPath: "./artifacts/random_forest.fhe",
  parametersPath: "./artifacts/random_forest.params",
  compiledAt: 0,
  inputSchema: [
    { name: "tx_value_eth",         type: "float32" as const, min: 0,  max: 10000  },
    { name: "tx_count_1h",          type: "uint64"  as const, min: 0,  max: 1000   },
    { name: "tx_count_24h",         type: "uint64"  as const, min: 0,  max: 10000  },
    { name: "unique_counterparts",  type: "uint64"  as const, min: 0,  max: 500    },
    { name: "gas_price_gwei",       type: "float32" as const, min: 0,  max: 10000  },
    { name: "contract_interaction", type: "uint64"  as const, min: 0,  max: 1      },
    { name: "time_since_last_tx",   type: "float32" as const, min: 0,  max: 86400  },
    { name: "balance_change_ratio", type: "float32" as const, min: -1, max: 1      },
  ],
};

// ── MODEL REGISTRY ────────────────────────────────────────────

const _registry = new Map<string, typeof BASE_ARTIFACT>();

export const ModelRegistry = {
  register(id: string, artifact: typeof BASE_ARTIFACT) {
    if (_registry.has(id)) throw new Error(`ModelRegistry: "${id}" already registered`);
    _registry.set(id, artifact);
  },
  get(id: string) {
    const a = _registry.get(id);
    if (!a) throw new Error(`ModelRegistry: "${id}" not found`);
    return a;
  },
  list() {
    return ["base-anomaly-rf-v1", ..._registry.keys()];
  },
};

// ── AGENT GUARD ───────────────────────────────────────────────

export class AgentGuard {
  readonly #config: AgentGuardConfig;
  readonly #eventHandlers = new Set<GuardEventHandler>();
  readonly #inferenceUrl: string;
  readonly #inferenceApiKey?: string;

  constructor(config: AgentGuardConfig) {
    this.#config = config;
    this.#inferenceUrl = config.inferenceServerUrl ?? "http://localhost:8000";
    this.#inferenceApiKey = config.inferenceApiKey;
  }

  // ── Public ────────────────────────────────────────────────

  async run(subject: string, queryParams?: Partial<ConnectorQuery>): Promise<TrustScoreResult> {
    const query: ConnectorQuery = { subject, windowSecs: 3600, limit: 100, ...queryParams };

    // 1. Fetch + merge features
    const merged = await this.#mergeFeatures(query);

    const flat: NormalizedFeatures = { ...merged.onChain, ...merged.offChain };
    this.#emit({ type: "features_merged", subject, features: flat });

    // 2. Encrypt
    const t0 = Date.now();
    const encrypted = await this.#encrypt(merged);
    this.#emit({ type: "encrypt_done", subject, durationMs: Date.now() - t0 });

    // 3. Predict
    const t1 = Date.now();
    const score = await this.#predict(encrypted, merged);
    this.#emit({ type: "predict_done", subject, label: score.label, durationMs: Date.now() - t1 });

    // 4. Act on blocked result
    if (score.label === "blocked") {
      const t2 = Date.now();
      await this.#config.onAnomaly({
        subject,
        result: score,
        contractAddress: this.#config.contractAddress,
      });
      this.#emit({ type: "anomaly_action", subject, handlerDurationMs: Date.now() - t2 });
    }

    return score;
  }

  watch(subject: string, queryParams?: Partial<ConnectorQuery>): () => void {
    const ms = this.#config.pollIntervalMs ?? 15_000;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      this.#emit({ type: "watch_tick", subject, tickAt: Date.now() });
      try { await this.run(subject, queryParams); } catch (e) { console.error("[AgentGuard]", e); }
      if (!stopped) setTimeout(tick, ms);
    };
    void tick();
    return () => { stopped = true; };
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const c of this.#config.connectors) {
      try { out[c.metadata.id] = c.healthCheck ? await c.healthCheck() : true; }
      catch { out[c.metadata.id] = false; }
    }
    return out;
  }

  onEvent(handler: GuardEventHandler): () => void {
    this.#eventHandlers.add(handler);
    return () => this.#eventHandlers.delete(handler);
  }

  // ── Private ───────────────────────────────────────────────

  #isInsufficientData(flat: NormalizedFeatures): boolean {
    const tx1h          = flat.tx_count_1h ?? 0;
    const tx24h         = flat.tx_count_24h ?? 0;
    const counterparts  = flat.unique_counterparts ?? 0;
    const gas           = flat.gas_price_gwei ?? 0;
    const contract      = flat.contract_interaction ?? 0;
    const sinceLast     = flat.time_since_last_tx ?? 86400;
    const balanceChange = Math.abs(flat.balance_change_ratio ?? 0);

    return (
      tx1h === 0 &&
      tx24h === 0 &&
      counterparts === 0 &&
      gas === 0 &&
      contract === 0 &&
      sinceLast >= 86400 &&
      balanceChange < 0.02
    );
  }

  async #mergeFeatures(query: ConnectorQuery): Promise<MergedFeatures> {
    const results = await Promise.allSettled(
      this.#config.connectors.map(async (c) => {
        const t = Date.now();
        this.#emit({ type: "fetch_start", subject: query.subject, connectorId: c.metadata.id });
        try {
          const raw = await c.fetch(query);
          const norm = await c.normalize(raw);
          this.#emit({ type: "fetch_done", subject: query.subject, connectorId: c.metadata.id, durationMs: Date.now() - t });
          return { kind: c.metadata.kind, norm };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.#emit({ type: "fetch_error", subject: query.subject, connectorId: c.metadata.id, error });
          throw error;
        }
      })
    );

    const onChainParts: NormalizedFeatures[] = [];
    const offChainParts: NormalizedFeatures[] = [];

    for (const r of results) {
      if (r.status === "fulfilled") {
        r.value.kind === "onchain" ? onChainParts.push(r.value.norm) : offChainParts.push(r.value.norm);
      }
    }

    const merge = (parts: NormalizedFeatures[]): NormalizedFeatures =>
      Object.assign({}, ...parts) as NormalizedFeatures;

    return {
      onChain:  onChainParts.length  > 0 ? merge(onChainParts)  : undefined,
      offChain: offChainParts.length > 0 ? merge(offChainParts) : undefined,
      mergedAt: Date.now(),
    };
  }

  async #encrypt(merged: MergedFeatures): Promise<EncryptedFeatures> {
    const artifact = this.#config.model.artifact === "base"
      ? BASE_ARTIFACT
      : this.#config.model.artifact;

    const flat: NormalizedFeatures = { ...merged.onChain, ...merged.offChain };

    // Quantize to uint64
    const quantized: Record<string, bigint> = {};
    for (const d of artifact.inputSchema) {
      const v = flat[d.name] ?? 0;
      const min = d.min ?? 0;
      const max = d.max ?? 1;
      const norm = Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
      quantized[d.name] = BigInt(Math.round(norm * 65535));
    }

    // TODO: replace with real Concrete ML WASM encryption
    const values = Object.values(quantized).join(",");
    return {
      schemaId: artifact.modelId,
      ciphertext: new TextEncoder().encode(`fhe:${artifact.modelId}:${values}`),
      encryptedAt: Date.now(),
    };
  }

  async #predict(features: EncryptedFeatures, merged: MergedFeatures): Promise<TrustScoreResult> {
    const artifact = this.#config.model.artifact === "base"
      ? BASE_ARTIFACT
      : this.#config.model.artifact;

    const flat = { ...merged.onChain, ...merged.offChain };
    const featureValues = artifact.inputSchema.map(d => flat[d.name] ?? 0);

    const mockHandle = BigInt("0x" + Buffer.from(features.ciphertext).toString("hex").slice(0, 16));

    // Low-signal wallets should not be treated as hard anomalies.
    if (this.#isInsufficientData(flat)) {
      return {
        encryptedScore: mockHandle,
        decision: 1n,
        label: "insufficient_data",
        computedAt: Date.now(),
        rawScore: 0,
        rawRisk: 1,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.#inferenceApiKey) {
      headers.Authorization = `Bearer ${this.#inferenceApiKey}`;
    }

    const res = await fetch(`${this.#inferenceUrl}/predict`, {
      method: "POST",
      headers,
      body: JSON.stringify({ features: featureValues, subject: "" }),
    });

    if (!res.ok) throw new Error(`Inference server error: HTTP ${res.status}`);

    const body = await res.json() as {
      label: string;
      prediction: number;
      risk_probability: number;
      trust_score: number;
    };

    const threshold = this.#config.model.threshold ?? 7;
    const trustScore = Math.max(0, Math.min(10, Math.round(body.trust_score)));
    const blocked = trustScore < threshold;

    return {
      encryptedScore: mockHandle,
      decision: BigInt(blocked ? 1 : 0),
      label: blocked ? "blocked" : "trusted",
      computedAt: Date.now(),
      rawScore: trustScore,
      rawRisk: body.risk_probability,
    };
  }

  #emit(event: Parameters<GuardEventHandler>[0]): void {
    for (const h of this.#eventHandlers) {
      try { h(event); } catch { /* never crash the guard */ }
    }
  }
}