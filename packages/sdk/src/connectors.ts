/**
 * FhEVMConnector
 * ──────────────
 * Fetches on-chain transaction features from an fhEVM-compatible RPC.
 * Uses ethers.js v6 to query:
 *   - ERC-20 / ERC-7984 Transfer logs (sent + received)
 *   - Gas prices from recent blocks
 *   - Block timestamps to compute time deltas
 *
 * Produces the 8 features expected by the Isolation Forest model.
 */

import { ethers } from "ethers";
import type {
  DataConnector,
  ConnectorMetadata,
  ConnectorQuery,
  NormalizedFeatures,
} from "./types.js";

// ── Minimal ABIs ──────────────────────────────────────────────

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
];

const ERC7984_ABI = [
  "event ConfidentialTransfer(address indexed from, address indexed to, uint256 encryptedValue)",
  "function balanceOf(address) view returns (uint256)",
];

// ── Config ────────────────────────────────────────────────────

export type FhEVMConnectorConfig = {
  rpcUrl: string
  /** Providing chainId skips ethers.js network auto-detection (faster, avoids timeout on slow RPCs) */
  chainId?: number
  tokenAddress?: `0x${string}`
  blockRange?: number    // default 7200 (~24h on Ethereum)
  blockRange1h?: number  // default 300  (~1h on Ethereum)
}

// ── Internal types ────────────────────────────────────────────

type TransferLog = {
  from: string
  to: string
  value: bigint
  blockNumber: number
  timestamp: number
  gasPrice: bigint
  isContract: boolean
}

type RawOnChainData = {
  transfers: TransferLog[]
  currentBalance: bigint
  previousBalance: bigint
  latestBlockTimestamp: number
  subject: string
}

// ── Connector ─────────────────────────────────────────────────

export class FhEVMConnector implements DataConnector {
  readonly metadata: ConnectorMetadata = {
    id: "fhevm",
    kind: "onchain",
    description: "Fetches transaction features from fhEVM RPC (ethers.js v6)",
  }

  readonly #cfg: Required<FhEVMConnectorConfig>
  #provider: ethers.JsonRpcProvider | null = null

  constructor(config: FhEVMConnectorConfig, provider?: ethers.JsonRpcProvider) {
    this.#cfg = {
      rpcUrl:       config.rpcUrl,
      chainId:      config.chainId ?? 0,
      tokenAddress: config.tokenAddress ?? ("" as `0x${string}`),
      blockRange:   config.blockRange   ?? 7200,
      blockRange1h: config.blockRange1h ?? 300,
    }
    if (provider) this.#provider = provider
  }

  async fetch(query: ConnectorQuery): Promise<RawOnChainData> {
    const provider    = this.#getProvider()
    const subject     = ethers.getAddress(query.subject)
    const latestBlock = await provider.getBlockNumber()
    const fromBlock   = Math.max(0, latestBlock - this.#cfg.blockRange)

    const [sentLogs, receivedLogs, latestBlockData] = await Promise.all([
      this.#getTransferLogs(provider, subject, fromBlock, latestBlock, "from"),
      this.#getTransferLogs(provider, subject, fromBlock, latestBlock, "to"),
      provider.getBlock(latestBlock),
    ])

    const allLogs = await this.#enrichLogs(provider, [...sentLogs, ...receivedLogs])
    const { current, previous } = await this.#getBalances(provider, subject, latestBlock, fromBlock)

    return {
      transfers:            allLogs,
      currentBalance:       current,
      previousBalance:      previous,
      latestBlockTimestamp: latestBlockData?.timestamp ?? Math.floor(Date.now() / 1000),
      subject,
    }
  }

  normalize(raw: unknown): Promise<NormalizedFeatures> {
    const data = raw as RawOnChainData
    const now  = data.latestBlockTimestamp

    const oneHourAgo   = now - 3600
    const transfers1h  = data.transfers.filter(t => t.timestamp >= oneHourAgo)
    const transfers24h = data.transfers

    // Most recent sent value in ETH
    const sent = transfers24h
      .filter(t => t.from.toLowerCase() === data.subject.toLowerCase())
      .sort((a, b) => b.timestamp - a.timestamp)
    const lastSentValue = sent[0]
      ? Number(ethers.formatEther(sent[0].value))
      : 0

    // Unique counterpart addresses
    const counterparts = new Set(
      transfers24h.map(t =>
        t.from.toLowerCase() === data.subject.toLowerCase() ? t.to : t.from
      )
    )

    // Median gas price in gwei
    const gasPrices = transfers24h.map(t => t.gasPrice).filter(g => g > 0n)
    const medianGas = gasPrices.length > 0
      ? Number(ethers.formatUnits(this.#median(gasPrices), "gwei"))
      : 0

    // Time since last tx in seconds
    const lastTxTs = transfers24h
      .sort((a, b) => b.timestamp - a.timestamp)[0]?.timestamp ?? 0
    const timeSinceLast = lastTxTs > 0 ? now - lastTxTs : 86400

    // Any contract interaction?
    const hasContractInteraction = transfers24h.some(t => t.isContract) ? 1 : 0

    // Relative balance change
    const cur  = Number(data.currentBalance)
    const prev = Number(data.previousBalance)
    const balanceChange = prev > 0 ? (cur - prev) / prev : 0

    return Promise.resolve({
      tx_value_eth:         lastSentValue,
      tx_count_1h:          transfers1h.length,
      tx_count_24h:         transfers24h.length,
      unique_counterparts:  counterparts.size,
      gas_price_gwei:       medianGas,
      contract_interaction: hasContractInteraction,
      time_since_last_tx:   Math.min(timeSinceLast, 86400),
      balance_change_ratio: Math.max(-1, Math.min(1, balanceChange)),
    })
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.#getProvider().getBlockNumber()
      return true
    } catch {
      return false
    }
  }

  // ── Private ───────────────────────────────────────────────────

  #getProvider(): ethers.JsonRpcProvider {
    if (!this.#provider) {
      // When chainId is known, pass staticNetwork to skip ethers network auto-detection.
      // This avoids a 1-second timeout on slow or rate-limited public RPCs.
      const network = this.#cfg.chainId > 0
        ? ethers.Network.from(this.#cfg.chainId)
        : undefined;
      this.#provider = new ethers.JsonRpcProvider(this.#cfg.rpcUrl, network, { staticNetwork: network ?? null })
    }
    return this.#provider
  }

  async #getTransferLogs(
    provider: ethers.JsonRpcProvider,
    subject: string,
    fromBlock: number,
    toBlock: number,
    direction: "from" | "to"
  ): Promise<ethers.Log[]> {
    const abi      = this.#cfg.tokenAddress ? ERC7984_ABI : ERC20_ABI
    const iface    = new ethers.Interface(abi)
    const eventSig = this.#cfg.tokenAddress
      ? iface.getEvent("ConfidentialTransfer")!.topicHash
      : iface.getEvent("Transfer")!.topicHash
    const padded   = ethers.zeroPadValue(subject, 32)

    return provider.getLogs({
      address:   this.#cfg.tokenAddress || undefined,
      fromBlock,
      toBlock,
      topics:    direction === "from"
        ? [eventSig, padded]         // Transfer(subject → *)
        : [eventSig, null, padded],  // Transfer(* → subject)
    })
  }

  async #enrichLogs(
    provider: ethers.JsonRpcProvider,
    logs: ethers.Log[]
  ): Promise<TransferLog[]> {
    if (logs.length === 0) return []

    const BATCH = 10

    // Fetch unique blocks for timestamps
    const blockNums  = [...new Set(logs.map(l => l.blockNumber))]
    const blockMap   = new Map<number, { timestamp: number; baseFeePerGas: bigint | null }>()

    for (let i = 0; i < blockNums.length; i += BATCH) {
      const blocks = await Promise.all(blockNums.slice(i, i + BATCH).map(n => provider.getBlock(n)))
      for (const b of blocks) {
        if (b) blockMap.set(b.number, { timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas ?? null })
      }
    }

    // Fetch unique tx receipts for gas price + contract detection
    const txHashes = [...new Set(logs.map(l => l.transactionHash))]
    const txMap    = new Map<string, { gasPrice: bigint; isContract: boolean }>()

    for (let i = 0; i < txHashes.length; i += BATCH) {
      const receipts = await Promise.all(txHashes.slice(i, i + BATCH).map(h => provider.getTransactionReceipt(h)))
      for (const r of receipts) {
        if (r) txMap.set(r.hash, { gasPrice: r.gasPrice ?? 0n, isContract: r.to === null })
      }
    }

    const iface  = new ethers.Interface(this.#cfg.tokenAddress ? ERC7984_ABI : ERC20_ABI)
    const result: TransferLog[] = []

    for (const log of logs) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data })
        if (!parsed) continue
        const blockInfo = blockMap.get(log.blockNumber)
        const txInfo    = txMap.get(log.transactionHash)
        result.push({
          from:        parsed.args["from"]  as string,
          to:          parsed.args["to"]    as string,
          value:       parsed.args["value"] as bigint ?? 0n,
          blockNumber: log.blockNumber,
          timestamp:   blockInfo?.timestamp ?? 0,
          gasPrice:    txInfo?.gasPrice     ?? blockInfo?.baseFeePerGas ?? 0n,
          isContract:  txInfo?.isContract   ?? false,
        })
      } catch { /* skip unparseable logs */ }
    }

    return result
  }

  async #getBalances(
    provider: ethers.JsonRpcProvider,
    subject: string,
    latestBlock: number,
    fromBlock: number
  ): Promise<{ current: bigint; previous: bigint }> {
    if (this.#cfg.tokenAddress) {
      const token = new ethers.Contract(this.#cfg.tokenAddress, ERC20_ABI, provider)
      try {
        const [current, previous] = await Promise.all([
          token["balanceOf"](subject) as Promise<bigint>,
          (token["balanceOf"](subject, { blockTag: fromBlock }) as Promise<bigint>).catch(() => 0n),
        ])
        return { current, previous }
      } catch { return { current: 0n, previous: 0n } }
    } else {
      const [current, previous] = await Promise.all([
        provider.getBalance(subject, latestBlock),
        provider.getBalance(subject, fromBlock).catch(() => 0n),
      ])
      return { current, previous }
    }
  }

  #median(values: bigint[]): bigint {
    if (values.length === 0) return 0n
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const mid    = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? (sorted[mid - 1]! + sorted[mid]!) / 2n
      : sorted[mid]!
  }
}

// ── BASE CONNECTOR ────────────────────────────────────────────

export abstract class BaseConnector implements DataConnector {
  abstract readonly metadata: ConnectorMetadata
  abstract fetch(query: ConnectorQuery): Promise<unknown>
  abstract normalize(raw: unknown): Promise<NormalizedFeatures>
  async healthCheck(): Promise<boolean> { return true }
}

// ── REST CONNECTOR ────────────────────────────────────────────

export type RESTConnectorConfig = {
  id: string
  baseUrl: string
  pathTemplate: string   // use {subject} as placeholder
  headers?: Record<string, string>
  fieldMap: Record<string, string>
  kind?: "onchain" | "offchain"
}

export class RESTConnector extends BaseConnector {
  readonly metadata: ConnectorMetadata
  readonly #cfg: RESTConnectorConfig

  constructor(config: RESTConnectorConfig) {
    super()
    this.#cfg     = config
    this.metadata = {
      id:          config.id,
      kind:        config.kind ?? "offchain",
      description: `REST → ${config.baseUrl}${config.pathTemplate}`,
    }
  }

  async fetch(query: ConnectorQuery): Promise<unknown> {
    const path = this.#cfg.pathTemplate.replace("{subject}", encodeURIComponent(query.subject))
    const res  = await fetch(`${this.#cfg.baseUrl}${path}`, { headers: this.#cfg.headers })
    if (!res.ok) throw new Error(`RESTConnector(${this.#cfg.id}): HTTP ${res.status}`)
    return res.json()
  }

  normalize(raw: unknown): Promise<NormalizedFeatures> {
    const obj    = raw as Record<string, unknown>
    const result: Record<string, number> = {}
    for (const [src, dest] of Object.entries(this.#cfg.fieldMap)) {
      const v = obj[src]
      if (typeof v === "number")  result[dest] = v
      else if (typeof v === "boolean") result[dest] = v ? 1 : 0
      else if (typeof v === "string") { const p = parseFloat(v); if (!isNaN(p)) result[dest] = p }
    }
    return Promise.resolve(result)
  }
}