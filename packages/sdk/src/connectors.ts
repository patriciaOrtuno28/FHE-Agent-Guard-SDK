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
  chainId?: number
  tokenAddress?: `0x${string}`
  blockRange?: number
  blockRange1h?: number
  explorerApiUrl?: string
  explorerApiKey?: string
  explorerMaxPages?: number
}

type TransferLog = {
  from: string
  to: string
  value: bigint
  blockNumber: number
  timestamp: number
  gasPrice: bigint
  isContract: boolean
}

type RuntimeTransaction = {
  hash?: string
  from: string | null
  to: string | null
  value: bigint
  blockNumber?: number
  timestamp: number
  gasPrice: bigint
  contractInteraction: boolean
}

type RawOnChainData = {
  transactions?: RuntimeTransaction[]
  transfers?: TransferLog[]
  currentBalance: bigint
  previousBalance: bigint
  latestBlockTimestamp: number
  subject: string
}

type BlockscoutAddressInfo = {
  coin_balance?: string
  is_contract?: boolean
}

type BlockscoutNextPageParams = Record<string, string | number | boolean>

type BlockscoutAddressTransactionsResponse = {
  items?: unknown[]
  next_page_params?: BlockscoutNextPageParams | null
}

export class FhEVMConnector implements DataConnector {
  readonly metadata: ConnectorMetadata = {
    id: "fhevm",
    kind: "onchain",
    description: "Fetches transaction features from explorer API or fhEVM RPC (ethers.js v6)",
  }

  readonly #cfg: Required<Omit<FhEVMConnectorConfig, "explorerApiUrl" | "explorerApiKey">> & {
    explorerApiUrl: string
    explorerApiKey: string
  }

  #provider: ethers.JsonRpcProvider | null = null

  constructor(config: FhEVMConnectorConfig, provider?: ethers.JsonRpcProvider) {
    this.#cfg = {
      rpcUrl: config.rpcUrl,
      chainId: config.chainId ?? 0,
      tokenAddress: config.tokenAddress ?? ("" as `0x${string}`),
      blockRange: config.blockRange ?? 7200,
      blockRange1h: config.blockRange1h ?? 300,
      explorerApiUrl: (config.explorerApiUrl ?? "").replace(/\/$/, ""),
      explorerApiKey: config.explorerApiKey ?? "",
      explorerMaxPages: config.explorerMaxPages ?? 10,
    }
    if (provider) this.#provider = provider
  }

  async fetch(query: ConnectorQuery): Promise<RawOnChainData> {
    const provider = this.#getProvider()
    const subject = ethers.getAddress(query.subject)

    const [latestBlockNumber, latestBlockData] = await Promise.all([
      provider.getBlockNumber(),
      provider.getBlock("latest"),
    ])

    const latestBlockTimestamp =
      latestBlockData?.timestamp ?? Math.floor(Date.now() / 1000)

    if (this.#cfg.explorerApiUrl) {
      const [transactions, currentBalance, previousBalance] = await Promise.all([
        this.#getTransactionsFromExplorer(subject, latestBlockTimestamp),
        this.#getCurrentBalanceFromExplorer(subject),
        this.#getPreviousBalanceFromExplorer(subject, latestBlockNumber),
      ])

      return {
        transactions,
        currentBalance,
        previousBalance,
        latestBlockTimestamp,
        subject,
      }
    }

    const fromBlock = Math.max(0, latestBlockNumber - this.#cfg.blockRange)

    const [sentLogs, receivedLogs] = await Promise.all([
      this.#getTransferLogs(provider, subject, fromBlock, latestBlockNumber, "from"),
      this.#getTransferLogs(provider, subject, fromBlock, latestBlockNumber, "to"),
    ])

    const allLogs = await this.#enrichLogs(provider, [...sentLogs, ...receivedLogs])
    const { current, previous } = await this.#getBalances(
      provider,
      subject,
      latestBlockNumber,
      fromBlock,
    )

    return {
      transfers: allLogs,
      currentBalance: current,
      previousBalance: previous,
      latestBlockTimestamp,
      subject,
    }
  }

  normalize(raw: unknown): Promise<NormalizedFeatures> {
    const data = raw as RawOnChainData
    const now = data.latestBlockTimestamp
    const subject = data.subject.toLowerCase()

    const transactions: RuntimeTransaction[] =
      data.transactions ??
      (data.transfers ?? []).map((t) => ({
        from: t.from,
        to: t.to,
        value: t.value,
        blockNumber: t.blockNumber,
        timestamp: t.timestamp,
        gasPrice: t.gasPrice,
        contractInteraction: t.isContract,
      }))

    const oneHourAgo = now - 3600
    const oneDayAgo = now - 86400

    const txs24h = transactions.filter((t) => t.timestamp >= oneDayAgo)
    const txs1h = txs24h.filter((t) => t.timestamp >= oneHourAgo)

    const sent24h = [...txs24h]
      .filter((t) => t.from?.toLowerCase() === subject)
      .sort((a, b) => b.timestamp - a.timestamp)

    const sentOverall = sent24h[0]
      ? sent24h
      : [...transactions]
          .filter((t) => t.from?.toLowerCase() === subject)
          .sort((a, b) => b.timestamp - a.timestamp)

    const lastSentValue = sentOverall[0]
      ? Number(ethers.formatEther(sentOverall[0].value))
      : 0

    const counterparts = new Set<string>()
    for (const tx of txs24h) {
      const counterpart = tx.from?.toLowerCase() === subject ? tx.to : tx.from
      if (counterpart && counterpart.toLowerCase() !== subject) {
        counterparts.add(counterpart.toLowerCase())
      }
    }

    const gasPrices = txs24h.map((t) => t.gasPrice).filter((g) => g > 0n)
    const medianGas =
      gasPrices.length > 0
        ? Number(ethers.formatUnits(this.#median(gasPrices), "gwei"))
        : 0

    const lastTxTs =
      [...transactions].sort((a, b) => b.timestamp - a.timestamp)[0]?.timestamp ?? 0
    const timeSinceLast = lastTxTs > 0 ? now - lastTxTs : 86400

    const hasContractInteraction = txs24h.some((t) => t.contractInteraction) ? 1 : 0

    const cur = Number(data.currentBalance)
    const prev = Number(data.previousBalance)
    const balanceChange = prev > 0 ? (cur - prev) / prev : 0

    return Promise.resolve({
      tx_value_eth: lastSentValue,
      tx_count_1h: txs1h.length,
      tx_count_24h: txs24h.length,
      unique_counterparts: counterparts.size,
      gas_price_gwei: medianGas,
      contract_interaction: hasContractInteraction,
      time_since_last_tx: Math.min(Math.max(timeSinceLast, 0), 86400),
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

  #getProvider(): ethers.JsonRpcProvider {
    if (!this.#provider) {
      const network = this.#cfg.chainId > 0
        ? ethers.Network.from(this.#cfg.chainId)
        : undefined

      this.#provider = new ethers.JsonRpcProvider(
        this.#cfg.rpcUrl,
        network,
        { staticNetwork: network ?? null },
      )
    }
    return this.#provider
  }

  async #getTransactionsFromExplorer(
    subject: string,
    latestBlockTimestamp: number,
  ): Promise<RuntimeTransaction[]> {
    const out: RuntimeTransaction[] = []
    let nextPageParams: BlockscoutNextPageParams | null = null
    const cutoff24h = latestBlockTimestamp - 86400

    for (let page = 0; page < this.#cfg.explorerMaxPages; page += 1) {
      const query = nextPageParams
        ? `?${new URLSearchParams(
            Object.entries(nextPageParams).map(([k, v]) => [k, String(v)]),
          )}`
        : ""

      const payload = await this.#fetchJson<BlockscoutAddressTransactionsResponse>(
        `${this.#cfg.explorerApiUrl}/addresses/${subject}/transactions${query}`,
      )

      const items = Array.isArray(payload?.items) ? payload.items : []
      if (items.length === 0) break

      for (const item of items) {
        const tx = this.#parseExplorerTransaction(item)
        if (tx) out.push(tx)
      }

      const timestamps = out.map((tx) => tx.timestamp)
      if (timestamps.length > 0 && Math.min(...timestamps) < cutoff24h) {
        break
      }

      nextPageParams = payload?.next_page_params ?? null
      if (!nextPageParams) break
    }

    return out.sort((a, b) => b.timestamp - a.timestamp)
  }

  async #getCurrentBalanceFromExplorer(subject: string): Promise<bigint> {
    const info = await this.#fetchJson<BlockscoutAddressInfo>(
      `${this.#cfg.explorerApiUrl}/addresses/${subject}`,
    )
    return this.#safeBigInt(info?.coin_balance)
  }

  async #getPreviousBalanceFromExplorer(
    subject: string,
    latestBlockNumber: number,
  ): Promise<bigint> {
    try {
      const payload = await this.#fetchJson<unknown>(
        `${this.#cfg.explorerApiUrl}/addresses/${subject}/coin-balance-history-by-day`,
      )

      const items = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { items?: unknown[] } | null)?.items)
          ? ((payload as { items?: unknown[] }).items ?? [])
          : []

      const cleaned = items
        .filter(
          (item): item is { date?: string; day?: string; value?: string } =>
            typeof item === "object" && item !== null,
        )
        .map((item) => ({
          date: String(item.date ?? item.day ?? ""),
          value: this.#safeBigInt(item.value),
        }))
        .filter((item) => item.date.length > 0)
        .sort((a, b) => a.date.localeCompare(b.date))

      if (cleaned.length >= 2) return cleaned.at(-2)?.value ?? 0n
      if (cleaned.length === 1) return cleaned[0]?.value ?? 0n
    } catch {
      // fall through
    }

    return this.#getProvider()
      .getBalance(subject, Math.max(0, latestBlockNumber - this.#cfg.blockRange))
      .catch(() => 0n)
  }

  async #fetchJson<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {}

    if (this.#cfg.explorerApiKey) {
      headers["x-api-key"] = this.#cfg.explorerApiKey
    }

    const res = await fetch(url, { headers })
    if (!res.ok) {
      throw new Error(`Explorer request failed: HTTP ${res.status} for ${url}`)
    }
    return (await res.json()) as T
  }

  #parseExplorerTransaction(item: unknown): RuntimeTransaction | null {
    if (!item || typeof item !== "object") return null
    const row = item as Record<string, unknown>

    const timestamp = this.#parseUnixOrIsoTimestamp(row.timestamp)
    if (timestamp === null) return null

    const from = this.#extractHash(row.from)
    const to = this.#extractHash(row.to)
    const value = this.#safeBigInt(row.value)
    const gasPrice = this.#safeBigInt(row.gas_price)
    const method = typeof row.method === "string" ? row.method.toLowerCase() : ""
    const rawInput = typeof row.raw_input === "string" ? row.raw_input : ""
    const decodedInput = row.decoded_input

    const contractInteraction = Boolean(
      this.#isContractObject(row.to) ||
      decodedInput ||
      (method && method !== "transfer" && method !== "transferfrom") ||
      (rawInput && rawInput !== "0x"),
    )

    return {
      hash: typeof row.hash === "string" ? row.hash : undefined,
      from,
      to,
      value,
      blockNumber: typeof row.block_number === "number" ? row.block_number : undefined,
      timestamp,
      gasPrice,
      contractInteraction,
    }
  }

  #extractHash(value: unknown): string | null {
    if (!value) return null

    if (typeof value === "string") {
      try {
        return ethers.getAddress(value)
      } catch {
        return null
      }
    }

    if (typeof value === "object" && value !== null) {
      const hash = (value as { hash?: unknown }).hash
      if (typeof hash === "string") {
        try {
          return ethers.getAddress(hash)
        } catch {
          return null
        }
      }
    }

    return null
  }

  #isContractObject(value: unknown): boolean {
    if (!value || typeof value !== "object") return false
    return Boolean((value as { is_contract?: unknown }).is_contract)
  }

  #parseUnixOrIsoTimestamp(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value !== "string") return null
    if (/^\d+$/.test(value)) return Number(value)

    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
  }

  #safeBigInt(value: unknown): bigint {
    if (typeof value === "bigint") return value
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value))
    }
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (!trimmed) return 0n
      try {
        return BigInt(trimmed)
      } catch {
        try {
          return BigInt(Math.trunc(Number(trimmed)))
        } catch {
          return 0n
        }
      }
    }
    return 0n
  }

  async #getTransferLogs(
    provider: ethers.JsonRpcProvider,
    subject: string,
    fromBlock: number,
    toBlock: number,
    direction: "from" | "to",
  ): Promise<ethers.Log[]> {
    const abi = this.#cfg.tokenAddress ? ERC7984_ABI : ERC20_ABI
    const iface = new ethers.Interface(abi)
    const eventSig = this.#cfg.tokenAddress
      ? iface.getEvent("ConfidentialTransfer")!.topicHash
      : iface.getEvent("Transfer")!.topicHash
    const padded = ethers.zeroPadValue(subject, 32)

    return provider.getLogs({
      address: this.#cfg.tokenAddress || undefined,
      fromBlock,
      toBlock,
      topics: direction === "from"
        ? [eventSig, padded]
        : [eventSig, null, padded],
    })
  }

  async #enrichLogs(
    provider: ethers.JsonRpcProvider,
    logs: ethers.Log[],
  ): Promise<TransferLog[]> {
    if (logs.length === 0) return []

    const BATCH = 10

    const blockNums = [...new Set(logs.map((l) => l.blockNumber))]
    const blockMap = new Map<number, { timestamp: number; baseFeePerGas: bigint | null }>()

    for (let i = 0; i < blockNums.length; i += BATCH) {
      const blocks = await Promise.all(
        blockNums.slice(i, i + BATCH).map((n) => provider.getBlock(n)),
      )
      for (const b of blocks) {
        if (b) {
          blockMap.set(b.number, {
            timestamp: b.timestamp,
            baseFeePerGas: b.baseFeePerGas ?? null,
          })
        }
      }
    }

    const txHashes = [...new Set(logs.map((l) => l.transactionHash))]
    const txMap = new Map<string, { gasPrice: bigint; isContract: boolean }>()

    for (let i = 0; i < txHashes.length; i += BATCH) {
      const receipts = await Promise.all(
        txHashes.slice(i, i + BATCH).map((h) => provider.getTransactionReceipt(h)),
      )

      for (const r of receipts) {
        if (r) {
          let isContract = false
          if (r.to) {
            try {
              const code = await provider.getCode(r.to)
              isContract = code !== "0x"
            } catch {
              isContract = false
            }
          } else {
            isContract = true
          }

          txMap.set(r.hash, {
            gasPrice: r.gasPrice ?? 0n,
            isContract,
          })
        }
      }
    }

    const iface = new ethers.Interface(this.#cfg.tokenAddress ? ERC7984_ABI : ERC20_ABI)
    const result: TransferLog[] = []

    for (const log of logs) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data })
        if (!parsed) continue

        const blockInfo = blockMap.get(log.blockNumber)
        const txInfo = txMap.get(log.transactionHash)

        result.push({
          from: parsed.args["from"] as string,
          to: parsed.args["to"] as string,
          value: (parsed.args["value"] as bigint) ?? 0n,
          blockNumber: log.blockNumber,
          timestamp: blockInfo?.timestamp ?? 0,
          gasPrice: txInfo?.gasPrice ?? blockInfo?.baseFeePerGas ?? 0n,
          isContract: txInfo?.isContract ?? false,
        })
      } catch {
        // skip
      }
    }

    return result
  }

  async #getBalances(
    provider: ethers.JsonRpcProvider,
    subject: string,
    latestBlock: number,
    fromBlock: number,
  ): Promise<{ current: bigint; previous: bigint }> {
    if (this.#cfg.tokenAddress) {
      const token = new ethers.Contract(this.#cfg.tokenAddress, ERC20_ABI, provider)
      try {
        const [current, previous] = await Promise.all([
          token["balanceOf"](subject) as Promise<bigint>,
          (token["balanceOf"](subject, { blockTag: fromBlock }) as Promise<bigint>).catch(() => 0n),
        ])
        return { current, previous }
      } catch {
        return { current: 0n, previous: 0n }
      }
    }

    const [current, previous] = await Promise.all([
      provider.getBalance(subject, latestBlock),
      provider.getBalance(subject, fromBlock).catch(() => 0n),
    ])

    return { current, previous }
  }

  #median(values: bigint[]): bigint {
    if (values.length === 0) return 0n
    const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const mid = Math.floor(sorted.length / 2)
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