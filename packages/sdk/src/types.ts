export type Address = `0x${string}`;

export type NetworkKey = "localhost" | "sepolia";

export type ContractAddresses = Record<string, Address>;

// ── FHE Agent Guard SDK types ─────────────────────────────────

export type FheHandle = bigint;

export type FeatureDescriptor = {
  readonly name: string;
  readonly type: "uint64" | "int64" | "float32";
  readonly min?: number;
  readonly max?: number;
  readonly description?: string;
};

export type FeatureSchema = ReadonlyArray<FeatureDescriptor>;

export type NormalizedFeatures = Readonly<Record<string, number>>;

export type EncryptedFeatures = {
  readonly schemaId: string;
  readonly ciphertext: Uint8Array;
  readonly encryptedAt: number;
};

export type MergedFeatures = {
  readonly onChain?: NormalizedFeatures;
  readonly offChain?: NormalizedFeatures;
  readonly mergedAt: number;
};

export type AnomalyScore = {
  readonly encryptedScore: FheHandle;
  readonly isAnomaly: FheHandle;
  readonly label: "anomaly_detected" | "normal" | "insufficient_data";
  readonly computedAt: number;
  /** Raw 0/1 prediction from the inference server — used by the client to produce a real fhevm ciphertext. */
  readonly rawPrediction?: number;
};

export type ConnectorQuery = {
  readonly subject: string;
  readonly windowSecs?: number;
  readonly limit?: number;
  readonly params?: Readonly<Record<string, unknown>>;
};

export type ConnectorMetadata = {
  readonly id: string;
  readonly kind: "onchain" | "offchain" | "hybrid";
  readonly description: string;
};

export interface DataConnector {
  readonly metadata: ConnectorMetadata;
  fetch(query: ConnectorQuery): Promise<unknown>;
  normalize(raw: unknown): Promise<NormalizedFeatures>;
  healthCheck?(): Promise<boolean>;
}

export type ModelKind = "isolation-forest" | "one-class-svm" | "autoencoder" | "custom";

export type FheArtifact = {
  readonly modelId: string;
  readonly version: string;
  readonly circuitPath: string;
  readonly parametersPath: string;
  readonly inputSchema: FeatureSchema;
  readonly compiledAt: number;
};

export type ModelConfig = {
  readonly kind: ModelKind;
  readonly artifact: "base" | FheArtifact;
  readonly threshold?: number;
};

export type AgentActionContext = {
  readonly subject: string;
  readonly result: AnomalyScore;
  readonly contractAddress?: Address;
};

export type OnAnomalyHandler = (ctx: AgentActionContext) => Promise<void>;

export type AgentGuardConfig = {
  readonly rpcUrl: string;
  readonly model: ModelConfig;
  readonly connectors: ReadonlyArray<DataConnector>;
  readonly onAnomaly: OnAnomalyHandler;
  readonly pollIntervalMs?: number;
  readonly contractAddress?: Address;
  /** URL of the Python inference server. Default: http://localhost:8000 */
  readonly inferenceServerUrl?: string;
  readonly inferenceApiKey?: string;
};

export type GuardEvent =
  | { type: "fetch_start";    subject: string; connectorId: string }
  | { type: "fetch_done";     subject: string; connectorId: string; durationMs: number }
  | { type: "fetch_error";    subject: string; connectorId: string; error: Error }
  | { type: "encrypt_done";   subject: string; durationMs: number }
  | { type: "predict_done";   subject: string; label: AnomalyScore["label"]; durationMs: number }
  | { type: "anomaly_action"; subject: string; handlerDurationMs: number }
  | { type: "watch_tick";     subject: string; tickAt: number }
  | { type: "features_merged"; subject: string; features: NormalizedFeatures };

export type GuardEventHandler = (event: GuardEvent) => void;