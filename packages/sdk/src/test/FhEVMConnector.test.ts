/**
 * FhEVMConnector tests
 * ────────────────────
 * Uses a mock ethers.js provider — no real RPC required.
 * Run: pnpm test (from packages/sdk)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import { FhEVMConnector } from "../connectors.js";

// ── Mock provider factory ─────────────────────────────────────

function makeMockProvider(overrides: Partial<{
  blockNumber: number
  blockTimestamp: number
  logs: ethers.Log[]
  balance: bigint
}> = {}) {
  const blockNumber    = overrides.blockNumber    ?? 1000
  const blockTimestamp = overrides.blockTimestamp ?? 1_700_000_000
  const logs           = overrides.logs           ?? []
  const balance        = overrides.balance        ?? ethers.parseEther("1.5")

  return {
    getBlockNumber:          vi.fn().mockResolvedValue(blockNumber),
    getBlock:                vi.fn().mockResolvedValue({ number: blockNumber, timestamp: blockTimestamp, baseFeePerGas: ethers.parseUnits("20", "gwei") }),
    getLogs:                 vi.fn().mockResolvedValue(logs),
    getBalance:              vi.fn().mockResolvedValue(balance),
    getTransactionReceipt:   vi.fn().mockResolvedValue(null),
  }
}

// ── Tests ─────────────────────────────────────────────────────

describe("FhEVMConnector", () => {
  let connector: FhEVMConnector

  beforeEach(() => {
    connector = new FhEVMConnector({ rpcUrl: "http://localhost:8545" })
  })

  it("has correct metadata", () => {
    expect(connector.metadata.id).toBe("fhevm")
    expect(connector.metadata.kind).toBe("onchain")
  })

  describe("normalize()", () => {
    it("returns all 8 expected features", async () => {
      const raw = {
        transfers:            [],
        currentBalance:       ethers.parseEther("2.0"),
        previousBalance:      ethers.parseEther("1.0"),
        latestBlockTimestamp: 1_700_000_000,
        subject:              "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      }

      const features = await connector.normalize(raw)

      expect(features).toHaveProperty("tx_value_eth")
      expect(features).toHaveProperty("tx_count_1h")
      expect(features).toHaveProperty("tx_count_24h")
      expect(features).toHaveProperty("unique_counterparts")
      expect(features).toHaveProperty("gas_price_gwei")
      expect(features).toHaveProperty("contract_interaction")
      expect(features).toHaveProperty("time_since_last_tx")
      expect(features).toHaveProperty("balance_change_ratio")
    })

    it("computes balance_change_ratio correctly", async () => {
      const raw = {
        transfers:            [],
        currentBalance:       ethers.parseEther("1.5"),
        previousBalance:      ethers.parseEther("1.0"),
        latestBlockTimestamp: 1_700_000_000,
        subject:              "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      }

      const { balance_change_ratio } = await connector.normalize(raw)
      // (1.5 - 1.0) / 1.0 = 0.5
      expect(balance_change_ratio).toBeCloseTo(0.5, 5)
    })

    it("clamps balance_change_ratio to [-1, 1]", async () => {
      const raw = {
        transfers:            [],
        currentBalance:       ethers.parseEther("100"),
        previousBalance:      ethers.parseEther("1"),
        latestBlockTimestamp: 1_700_000_000,
        subject:              "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      }

      const { balance_change_ratio } = await connector.normalize(raw)
      expect(balance_change_ratio).toBeLessThanOrEqual(1)
      expect(balance_change_ratio).toBeGreaterThanOrEqual(-1)
    })

    it("returns time_since_last_tx = 86400 when no transfers", async () => {
      const raw = {
        transfers:            [],
        currentBalance:       0n,
        previousBalance:      0n,
        latestBlockTimestamp: 1_700_000_000,
        subject:              "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      }

      const { time_since_last_tx } = await connector.normalize(raw)
      expect(time_since_last_tx).toBe(86400)
    })

    it("counts 1h vs 24h transfers correctly", async () => {
      const now    = 1_700_000_000
      const recent = now - 1800   // 30 min ago → inside 1h window
      const old    = now - 7200   // 2h ago → inside 24h but outside 1h

      const subject = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

      const raw = {
        transfers: [
          { from: subject, to: "0xabc", value: ethers.parseEther("1"), blockNumber: 900, timestamp: recent, gasPrice: ethers.parseUnits("25", "gwei"), isContract: false },
          { from: subject, to: "0xdef", value: ethers.parseEther("2"), blockNumber: 800, timestamp: old,    gasPrice: ethers.parseUnits("20", "gwei"), isContract: false },
        ],
        currentBalance:       ethers.parseEther("5"),
        previousBalance:      ethers.parseEther("5"),
        latestBlockTimestamp: now,
        subject,
      }

      const features = await connector.normalize(raw)
      expect(features.tx_count_1h).toBe(1)
      expect(features.tx_count_24h).toBe(2)
    })

    it("detects contract interaction", async () => {
      const now     = 1_700_000_000
      const subject = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

      const raw = {
        transfers: [
          { from: subject, to: "0xcontract", value: 0n, blockNumber: 999, timestamp: now - 60, gasPrice: 0n, isContract: true },
        ],
        currentBalance: 0n, previousBalance: 0n,
        latestBlockTimestamp: now, subject,
      }

      const { contract_interaction } = await connector.normalize(raw)
      expect(contract_interaction).toBe(1)
    })
  })

  describe("healthCheck()", () => {
    it("returns true when RPC responds", async () => {
      const mockProvider = {
        getBlockNumber: vi.fn().mockResolvedValue(100),
      } as unknown as ethers.JsonRpcProvider;

      const ok = await new FhEVMConnector({ rpcUrl: "http://localhost:8545" }, mockProvider).healthCheck()
      expect(ok).toBe(true)
    })

    it("returns false when RPC fails", async () => {
      const mockProvider = {
        getBlockNumber: vi.fn().mockRejectedValue(new Error("connection refused")),
      } as unknown as ethers.JsonRpcProvider;

      const ok = await new FhEVMConnector({ rpcUrl: "http://localhost:8545" }, mockProvider).healthCheck()
      expect(ok).toBe(false)
    })
  })
})
