/**
 * AgentGuard integration tests
 * ─────────────────────────────
 * Tests the full run() pipeline with a mock connector.
 * No RPC or FHE required.
 */

import { describe, it, expect, vi } from "vitest";
import { AgentGuard } from "../AgentGuard.js";
import type { DataConnector, ConnectorMetadata, ConnectorQuery, NormalizedFeatures } from "../types.js";

// ── Mock connector ────────────────────────────────────────────

function makeMockConnector(kind: "onchain" | "offchain" = "onchain"): DataConnector {
  return {
    metadata: { id: "mock", kind, description: "mock" } satisfies ConnectorMetadata,
    fetch: vi.fn().mockResolvedValue({}),
    normalize: vi.fn().mockResolvedValue({
      tx_value_eth: 1.5, tx_count_1h: 3, tx_count_24h: 12,
      unique_counterparts: 5, gas_price_gwei: 25,
      contract_interaction: 0, time_since_last_tx: 300,
      balance_change_ratio: 0.05,
    } satisfies NormalizedFeatures),
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe("AgentGuard", () => {
  it("run() calls fetch + normalize on each connector", async () => {
    const connector  = makeMockConnector()
    const onAnomaly  = vi.fn()

    const guard = new AgentGuard({
      rpcUrl:     "http://localhost:8545",
      model:      { kind: "isolation-forest", artifact: "base", threshold: 0.65 },
      connectors: [connector],
      onAnomaly,
    })

    await guard.run("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")

    expect(connector.fetch).toHaveBeenCalledOnce()
    expect(connector.normalize).toHaveBeenCalledOnce()
  })

  it("emits fetch_start and fetch_done events", async () => {
    const connector = makeMockConnector()
    const events: string[] = []

    const guard = new AgentGuard({
      rpcUrl:     "http://localhost:8545",
      model:      { kind: "isolation-forest", artifact: "base" },
      connectors: [connector],
      onAnomaly:  vi.fn(),
    })

    guard.onEvent(ev => events.push(ev.type))
    await guard.run("0xabc")

    expect(events).toContain("fetch_start")
    expect(events).toContain("fetch_done")
    expect(events).toContain("encrypt_done")
    expect(events).toContain("predict_done")
  })

  it("healthCheck() returns true for healthy connector", async () => {
    const connector = { ...makeMockConnector(), healthCheck: vi.fn().mockResolvedValue(true) }

    const guard = new AgentGuard({
      rpcUrl:     "http://localhost:8545",
      model:      { kind: "isolation-forest", artifact: "base" },
      connectors: [connector],
      onAnomaly:  vi.fn(),
    })

    const health = await guard.healthCheck()
    expect(health["mock"]).toBe(true)
  })

  it("watch() returns a stop function", () => {
    const guard = new AgentGuard({
      rpcUrl:     "http://localhost:8545",
      model:      { kind: "isolation-forest", artifact: "base" },
      connectors: [makeMockConnector()],
      onAnomaly:  vi.fn(),
      pollIntervalMs: 999_999,
    })

    const stop = guard.watch("0xabc")
    expect(typeof stop).toBe("function")
    stop()
  })

  it("does not call onAnomaly when label is normal", async () => {
    const connector = makeMockConnector()
    const onAnomaly = vi.fn()

    const guard = new AgentGuard({
      rpcUrl:     "http://localhost:8545",
      model:      { kind: "isolation-forest", artifact: "base" },
      connectors: [connector],
      onAnomaly,
    })

    await guard.run("0xabc")
    // Base model stub always returns 'normal'
    expect(onAnomaly).not.toHaveBeenCalled()
  })
})
