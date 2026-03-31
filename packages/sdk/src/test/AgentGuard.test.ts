/**
 * AgentGuard integration tests
 * ─────────────────────────────
 * Tests the full run() pipeline with a mock connector.
 * No RPC or FHE required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentGuard } from "../AgentGuard.js";
import type { DataConnector, ConnectorMetadata, NormalizedFeatures } from "../types.js";

// ── Mock connector ────────────────────────────────────────────

function makeMockConnector(kind: "onchain" | "offchain" = "onchain"): DataConnector {
  return {
    metadata: { id: "mock", kind, description: "mock" } satisfies ConnectorMetadata,
    fetch: vi.fn().mockResolvedValue({}),
    normalize: vi.fn().mockResolvedValue({
      tx_value_eth: 1.5,
      tx_count_1h: 3,
      tx_count_24h: 12,
      unique_counterparts: 5,
      gas_price_gwei: 25,
      contract_interaction: 0,
      time_since_last_tx: 300,
      balance_change_ratio: 0.05,
    } satisfies NormalizedFeatures),
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("AgentGuard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        label: "trusted",
        prediction: 0,
        risk_probability: 0.2,
        trust_score: 8,
      }),
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("run() calls fetch + normalize on each connector", async () => {
    const connector = makeMockConnector();
    const onAnomaly = vi.fn();

    const guard = new AgentGuard({
      rpcUrl: "http://localhost:8545",
      model: { kind: "random-forest", artifact: "base", threshold: 7 },
      connectors: [connector],
      onAnomaly,
    });

    await guard.run("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");

    expect(connector.fetch).toHaveBeenCalledOnce();
    expect(connector.normalize).toHaveBeenCalledOnce();
  });

  it("emits fetch_start and fetch_done events", async () => {
    const connector = makeMockConnector();
    const events: string[] = [];

    const guard = new AgentGuard({
      rpcUrl: "http://localhost:8545",
      model: { kind: "random-forest", artifact: "base", threshold: 7 },
      connectors: [connector],
      onAnomaly: vi.fn(),
    });

    guard.onEvent((ev) => events.push(ev.type));
    await guard.run("0xabc");

    expect(events).toContain("fetch_start");
    expect(events).toContain("fetch_done");
    expect(events).toContain("encrypt_done");
    expect(events).toContain("predict_done");
  });

  it("healthCheck() returns true for healthy connector", async () => {
    const connector = { ...makeMockConnector(), healthCheck: vi.fn().mockResolvedValue(true) };

    const guard = new AgentGuard({
      rpcUrl: "http://localhost:8545",
      model: { kind: "random-forest", artifact: "base", threshold: 7 },
      connectors: [connector],
      onAnomaly: vi.fn(),
    });

    const health = await guard.healthCheck();
    expect(health["mock"]).toBe(true);
  });

  it("watch() returns a stop function", () => {
    const guard = new AgentGuard({
      rpcUrl: "http://localhost:8545",
      model: { kind: "random-forest", artifact: "base", threshold: 7 },
      connectors: [makeMockConnector()],
      onAnomaly: vi.fn(),
      pollIntervalMs: 999_999,
    });

    vi.spyOn(guard, "run").mockResolvedValue({
      encryptedScore: 0n,
      decision: 0n,
      label: "trusted",
      computedAt: Date.now(),
      rawScore: 8,
      rawRisk: 0.2,
    });

    const stop = guard.watch("0xabc");
    expect(typeof stop).toBe("function");
    stop();
  });

  it("does not call onAnomaly when label is trusted", async () => {
    const connector = makeMockConnector();
    const onAnomaly = vi.fn();

    const guard = new AgentGuard({
      rpcUrl: "http://localhost:8545",
      model: { kind: "random-forest", artifact: "base", threshold: 7 },
      connectors: [connector],
      onAnomaly,
    });

    await guard.run("0xabc");
    expect(onAnomaly).not.toHaveBeenCalled();
  });
});
