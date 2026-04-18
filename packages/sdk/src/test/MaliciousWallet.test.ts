/**
 * TODO Step 13 — Malicious Wallet Simulation
 * ────────────────────────────────────────────
 * Simulates wallets with anomalous on-chain behaviour and verifies that
 * AgentGuard correctly labels them "blocked" and triggers onAnomaly.
 *
 * Attack profiles covered:
 *   1. Bot / spam wallet        — extreme tx volume in short windows
 *   2. Large-value attacker     — single enormous transfer + near-total drain
 *   3. Flash-loan attacker      — contract interaction + high gas + rapid txs
 *   4. Score boundary           — score exactly at and one below the threshold
 *   5. Trusted wallet           — regression guard, must still pass
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentGuard } from "../AgentGuard.js";
import type { DataConnector, ConnectorMetadata, NormalizedFeatures } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────

const MALICIOUS_ADDRESS = "0xDeadBeef00000000000000000000000000000001";
const TRUSTED_ADDRESS   = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const THRESHOLD = 7;

function makeConnector(features: NormalizedFeatures): DataConnector {
  return {
    metadata: { id: "mock", kind: "onchain", description: "mock" } satisfies ConnectorMetadata,
    fetch:     vi.fn().mockResolvedValue({}),
    normalize: vi.fn().mockResolvedValue(features),
  };
}

function stubInference(trustScore: number, riskProbability: number) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok:   true,
    json: async () => ({
      label:            trustScore >= THRESHOLD ? "trusted" : "blocked",
      prediction:       riskProbability >= 0.5 ? 1 : 0,
      risk_probability: riskProbability,
      trust_score:      trustScore,
    }),
  }));
}

function makeGuard(connector: DataConnector, onAnomaly = vi.fn().mockResolvedValue(undefined)) {
  const guard = new AgentGuard({
    rpcUrl:   "http://localhost:8545",
    model:    { kind: "random-forest", artifact: "base", threshold: THRESHOLD },
    connectors: [connector],
    onAnomaly,
  });
  return { guard, onAnomaly };
}

// ── Malicious wallet feature profiles ─────────────────────────

/** 487 txs/h, 3 821 txs/24h, 412 unique targets — classic bot scatter */
const BOT_SPAMMER: NormalizedFeatures = {
  tx_value_eth:         0.001,
  tx_count_1h:          487,
  tx_count_24h:         3821,
  unique_counterparts:  412,
  gas_price_gwei:       150,
  contract_interaction: 0,
  time_since_last_tx:   3,     // 3 s ago
  balance_change_ratio: -0.02,
};

/** 4 500 ETH in one tx, extreme gas, near-total balance drain */
const LARGE_VALUE_ATTACKER: NormalizedFeatures = {
  tx_value_eth:         4500,
  tx_count_1h:          2,
  tx_count_24h:         5,
  unique_counterparts:  2,
  gas_price_gwei:       8000,
  contract_interaction: 0,
  time_since_last_tx:   120,
  balance_change_ratio: -0.97,
};

/** Flash loan signature: contract interaction + high gas + rapid multi-target */
const FLASH_LOAN_ATTACKER: NormalizedFeatures = {
  tx_value_eth:         2000,
  tx_count_1h:          45,
  tx_count_24h:         50,
  unique_counterparts:  38,
  gas_price_gwei:       5000,
  contract_interaction: 1,
  time_since_last_tx:   8,
  balance_change_ratio: -0.85,
};

/** Completely normal, low-risk wallet */
const TRUSTED_WALLET: NormalizedFeatures = {
  tx_value_eth:         1.2,
  tx_count_1h:          2,
  tx_count_24h:         9,
  unique_counterparts:  4,
  gas_price_gwei:       22,
  contract_interaction: 0,
  time_since_last_tx:   3600,
  balance_change_ratio: 0.04,
};

// ── Tests ─────────────────────────────────────────────────────

describe("Malicious wallet simulation (TODO Step 13)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── 1. Bot / spammer ────────────────────────────────────────

  describe("Bot / spam wallet", () => {
    beforeEach(() => stubInference(1, 0.94));

    it("is labelled blocked", async () => {
      const { guard } = makeGuard(makeConnector(BOT_SPAMMER));
      const result = await guard.run(MALICIOUS_ADDRESS);
      expect(result.label).toBe("blocked");
    });

    it("returns a trust score below the threshold", async () => {
      const { guard } = makeGuard(makeConnector(BOT_SPAMMER));
      const result = await guard.run(MALICIOUS_ADDRESS);
      expect(result.rawScore).toBeLessThan(THRESHOLD);
    });

    it("triggers onAnomaly callback", async () => {
      const { guard, onAnomaly } = makeGuard(makeConnector(BOT_SPAMMER));
      await guard.run(MALICIOUS_ADDRESS);
      expect(onAnomaly).toHaveBeenCalledOnce();
      expect(onAnomaly).toHaveBeenCalledWith(
        expect.objectContaining({ subject: MALICIOUS_ADDRESS }),
      );
    });

    it("emits anomaly_action event", async () => {
      const { guard } = makeGuard(makeConnector(BOT_SPAMMER));
      const events: string[] = [];
      guard.onEvent((ev) => events.push(ev.type));
      await guard.run(MALICIOUS_ADDRESS);
      expect(events).toContain("anomaly_action");
    });
  });

  // ── 2. Large-value attacker ─────────────────────────────────

  describe("Large-value attacker", () => {
    beforeEach(() => stubInference(2, 0.91));

    it("is labelled blocked", async () => {
      const { guard } = makeGuard(makeConnector(LARGE_VALUE_ATTACKER));
      const result = await guard.run(MALICIOUS_ADDRESS);
      expect(result.label).toBe("blocked");
    });

    it("returns a high risk probability", async () => {
      const { guard } = makeGuard(makeConnector(LARGE_VALUE_ATTACKER));
      const result = await guard.run(MALICIOUS_ADDRESS);
      expect(result.rawRisk).toBeGreaterThan(0.5);
    });

    it("triggers onAnomaly callback", async () => {
      const { guard, onAnomaly } = makeGuard(makeConnector(LARGE_VALUE_ATTACKER));
      await guard.run(MALICIOUS_ADDRESS);
      expect(onAnomaly).toHaveBeenCalledOnce();
    });
  });

  // ── 3. Flash-loan attacker ──────────────────────────────────

  describe("Flash-loan attacker", () => {
    beforeEach(() => stubInference(0, 0.98));

    it("is labelled blocked", async () => {
      const { guard } = makeGuard(makeConnector(FLASH_LOAN_ATTACKER));
      const result = await guard.run(MALICIOUS_ADDRESS);
      expect(result.label).toBe("blocked");
    });

    it("returns the lowest possible trust score (0)", async () => {
      const { guard } = makeGuard(makeConnector(FLASH_LOAN_ATTACKER));
      const result = await guard.run(MALICIOUS_ADDRESS);
      expect(result.rawScore).toBe(0);
    });

    it("triggers onAnomaly callback", async () => {
      const { guard, onAnomaly } = makeGuard(makeConnector(FLASH_LOAN_ATTACKER));
      await guard.run(MALICIOUS_ADDRESS);
      expect(onAnomaly).toHaveBeenCalledOnce();
    });
  });

  // ── 4. Score boundary ───────────────────────────────────────

  describe("Score boundary (threshold = 7)", () => {
    it("blocks a wallet with score 6 (one below threshold)", async () => {
      stubInference(6, 0.45);
      const { guard, onAnomaly } = makeGuard(makeConnector(BOT_SPAMMER));
      const result = await guard.run(MALICIOUS_ADDRESS);
      expect(result.label).toBe("blocked");
      expect(result.rawScore).toBe(6);
      expect(onAnomaly).toHaveBeenCalledOnce();
    });

    it("allows a wallet with score exactly at threshold (7)", async () => {
      stubInference(7, 0.30);
      const { guard, onAnomaly } = makeGuard(makeConnector(TRUSTED_WALLET));
      const result = await guard.run(TRUSTED_ADDRESS);
      expect(result.label).toBe("trusted");
      expect(onAnomaly).not.toHaveBeenCalled();
    });
  });

  // ── 5. Regression — trusted wallet still passes ─────────────

  describe("Trusted wallet (regression)", () => {
    beforeEach(() => stubInference(9, 0.08));

    it("is labelled trusted", async () => {
      const { guard } = makeGuard(makeConnector(TRUSTED_WALLET));
      const result = await guard.run(TRUSTED_ADDRESS);
      expect(result.label).toBe("trusted");
    });

    it("does not trigger onAnomaly", async () => {
      const { guard, onAnomaly } = makeGuard(makeConnector(TRUSTED_WALLET));
      await guard.run(TRUSTED_ADDRESS);
      expect(onAnomaly).not.toHaveBeenCalled();
    });

    it("returns a trust score above the threshold", async () => {
      const { guard } = makeGuard(makeConnector(TRUSTED_WALLET));
      const result = await guard.run(TRUSTED_ADDRESS);
      expect(result.rawScore).toBeGreaterThanOrEqual(THRESHOLD);
    });
  });
});
