'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { NETWORKS, networkByChainId, type NetworkId } from '../lib/networks';
import { decryptAnomalyScore, isFheSupported, resetFhevmInstance } from '../lib/fhe';

// ── Ethereum provider type (MetaMask) ────────────────────────────────────────

declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
      on(event: string, handler: (...args: unknown[]) => void): void;
      removeListener(event: string, handler: (...args: unknown[]) => void): void;
    };
  }
}

// ── Contract addresses (per chain) ───────────────────────────────────────────
// Update 11155111 once AnomalyAgent is deployed to Sepolia.

const ANOMALY_AGENT_ADDRESS: Partial<Record<number, `0x${string}`>> = {
  31337: '0x5FbDB2315678afecb367f032d93F642f64180aa3', // localhost Hardhat
};

// ── Types ────────────────────────────────────────────────────────────────────

type LogKind = 'start' | 'success' | 'error' | 'encrypt' | 'predict' | 'fetch' | 'info';

interface LogEntry {
  id: number;
  ts: number;
  kind: LogKind;
  message: string;
  durationMs?: number;
}

interface HealthState {
  inference: boolean | null;
  rpc: boolean | null;
  network: string | null;
}

interface ScanResult {
  label: 'anomaly_detected' | 'normal' | 'insufficient_data';
  encryptedScore: string;
  isAnomaly: string;
  computedAt: number;
}

interface FeatureEntry {
  key: string;
  value: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const FEATURE_LABELS: Record<string, string> = {
  tx_value_eth:         'TX Value (ETH)',
  tx_count_1h:          'TX Count 1h',
  tx_count_24h:         'TX Count 24h',
  unique_counterparts:  'Unique Counterparts',
  gas_price_gwei:       'Gas Price (Gwei)',
  contract_interaction: 'Contract Interaction',
  time_since_last_tx:   'Time Since Last TX (s)',
  balance_change_ratio: 'Balance Change Ratio',
};

let logIdCounter = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 23);
}

function logIcon(kind: LogKind): string {
  switch (kind) {
    case 'start':   return '▶';
    case 'success': return '✓';
    case 'error':   return '✗';
    case 'encrypt': return '🔒';
    case 'predict': return '◈';
    case 'fetch':   return '↓';
    case 'info':    return '·';
  }
}

function logColor(kind: LogKind): string {
  switch (kind) {
    case 'start':   return 'text-blue-400';
    case 'success': return 'text-emerald-400';
    case 'error':   return 'text-red-400';
    case 'encrypt': return 'text-violet-400';
    case 'predict': return 'text-amber-400';
    case 'fetch':   return 'text-zinc-400';
    case 'info':    return 'text-zinc-500';
  }
}

function makeLog(kind: LogKind, message: string, durationMs?: number): LogEntry {
  return { id: ++logIdCounter, ts: Date.now(), kind, message, durationMs };
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ ok, label }: { ok: boolean | null; label: string }) {
  const color = ok === null ? 'bg-zinc-600' : ok ? 'bg-emerald-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5 text-xs text-zinc-400">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />
      {label}
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className="log-entry flex items-baseline gap-3 text-xs leading-relaxed px-4 py-0.5 hover:bg-zinc-900/40">
      <span className="text-zinc-600 flex-shrink-0 tabular-nums">{ts(entry.ts)}</span>
      <span className={`flex-shrink-0 w-4 text-center font-bold ${logColor(entry.kind)}`}>{logIcon(entry.kind)}</span>
      <span className={`flex-1 min-w-0 break-all ${entry.kind === 'info' ? 'text-zinc-500' : 'text-zinc-300'}`}>
        {entry.message}
      </span>
      {entry.durationMs !== undefined && (
        <span className="flex-shrink-0 text-zinc-600 tabular-nums text-[10px]">{entry.durationMs}ms</span>
      )}
    </div>
  );
}

function ResultPanel({
  result,
  canDecrypt,
  contractAddress,
  walletAddress,
  chainId,
  decryptedScore,
  decrypting,
  decryptError,
  onDecrypt,
}: {
  result: ScanResult;
  canDecrypt: boolean;
  contractAddress?: `0x${string}`;
  walletAddress: string;
  chainId: number;
  decryptedScore: bigint | null;
  decrypting: boolean;
  decryptError: string | null;
  onDecrypt: () => void;
}) {
  const isAnomaly = result.label === 'anomaly_detected';
  const isInsuff  = result.label === 'insufficient_data';

  const glowClass = isAnomaly
    ? 'shadow-[0_0_30px_rgba(239,68,68,0.25)] border-red-500/40'
    : isInsuff
      ? 'border-amber-500/40 shadow-[0_0_30px_rgba(245,158,11,0.15)]'
      : 'shadow-[0_0_30px_rgba(16,185,129,0.2)] border-emerald-500/40';

  const labelText  = isAnomaly ? 'ANOMALY DETECTED' : isInsuff ? 'INSUFFICIENT DATA' : 'NORMAL';
  const labelColor = isAnomaly ? 'text-red-400'     : isInsuff ? 'text-amber-400'    : 'text-emerald-400';

  return (
    <div className={`mx-4 mb-4 p-4 rounded border bg-zinc-950/80 ${glowClass}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">Scan Result</span>
        <span className="text-[10px] text-zinc-600 tabular-nums">{new Date(result.computedAt).toISOString()}</span>
      </div>

      <div className={`text-2xl font-black tracking-tight mb-3 ${labelColor}`}>{labelText}</div>

      {/* Encrypted handles */}
      <div className="space-y-1.5 mb-3">
        <div className="flex items-start gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide flex-shrink-0 mt-0.5 w-28">Encrypted Score</span>
          <span className="text-xs text-violet-400 font-mono break-all">{result.encryptedScore}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide flex-shrink-0 w-28">Is Anomaly Handle</span>
          <span className="text-xs text-violet-400 font-mono">{result.isAnomaly}</span>
        </div>
      </div>

      {/* Decryption */}
      {canDecrypt && contractAddress ? (
        <div className="border-t border-zinc-800/60 pt-3 mt-3">
          {decryptedScore !== null ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide w-28 flex-shrink-0">Decrypted Score</span>
              <span className="text-sm font-black text-emerald-300 font-mono">{decryptedScore.toString()}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] text-zinc-500 leading-relaxed">
                Sign with MetaMask to decrypt your anomaly score from the blockchain.
                The KMS verifies the on-chain ACL before revealing the plaintext.
              </p>
              <button
                onClick={onDecrypt}
                disabled={decrypting}
                className="w-full py-2 rounded border border-violet-500/50 text-violet-400 text-xs font-semibold
                           hover:bg-violet-500/10 hover:border-violet-400 transition-all duration-150
                           disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2"
              >
                {decrypting ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
                    Signing & decrypting…
                  </>
                ) : (
                  '🔓 Decrypt My Score'
                )}
              </button>
              {decryptError && (
                <p className="text-[10px] text-red-400 leading-relaxed">{decryptError}</p>
              )}
            </div>
          )}
        </div>
      ) : canDecrypt && !contractAddress ? (
        <div className="border-t border-zinc-800/60 pt-3 mt-3">
          <p className="text-[10px] text-zinc-600 italic">
            AnomalyAgent not deployed on chain {chainId} yet — deploy with{' '}
            <span className="font-mono">pnpm deploy:sepolia</span> to enable on-chain decryption.
          </p>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600 leading-relaxed mt-3">
          Scores computed under FHE — plaintext values never leave your machine.
          Switch to Sepolia to enable on-chain decryption via the Zama KMS.
        </p>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  // Wallet
  const [walletAddress,    setWalletAddress]    = useState<string | null>(null);
  const [walletChainId,    setWalletChainId]    = useState<number | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletError,      setWalletError]      = useState<string | null>(null);

  // Network (UI selector — may differ from MetaMask's active chain)
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkId>('sepolia');

  // Scan
  const [scanning,  setScanning]  = useState(false);
  const [logs,      setLogs]      = useState<LogEntry[]>([]);
  const [features,  setFeatures]  = useState<FeatureEntry[]>([]);
  const [result,    setResult]    = useState<ScanResult | null>(null);

  // Decryption
  const [decryptedScore, setDecryptedScore] = useState<bigint | null>(null);
  const [decrypting,     setDecrypting]     = useState(false);
  const [decryptError,   setDecryptError]   = useState<string | null>(null);

  // Health
  const [health, setHealth] = useState<HealthState>({ inference: null, rpc: null, network: null });

  const logBottomRef = useRef<HTMLDivElement>(null);
  const abortRef     = useRef<AbortController | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────

  const activeNetwork    = NETWORKS.find((n) => n.id === selectedNetwork)!;
  const contractAddress  = walletChainId ? ANOMALY_AGENT_ADDRESS[walletChainId] : undefined;
  const fheDecryptReady  = walletChainId !== null && isFheSupported(walletChainId);

  // ── Health polling ────────────────────────────────────────────────────────

  const pollHealth = useCallback(async (net: NetworkId) => {
    try {
      const res  = await fetch(`/api/health?network=${net}`);
      if (!res.ok) return;
      const data = await res.json() as { checks: { inference?: boolean; rpc?: boolean }; network?: string };
      setHealth({ inference: data.checks.inference ?? null, rpc: data.checks.rpc ?? null, network: data.network ?? null });
    } catch {
      setHealth({ inference: false, rpc: false, network: null });
    }
  }, []);

  useEffect(() => {
    void pollHealth(selectedNetwork);
    const id = setInterval(() => { void pollHealth(selectedNetwork); }, 10_000);
    return () => clearInterval(id);
  }, [pollHealth, selectedNetwork]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────

  useEffect(() => {
    logBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // ── MetaMask: restore session on mount ───────────────────────────────────

  useEffect(() => {
    if (!window.ethereum) return;
    void window.ethereum.request<string[]>({ method: 'eth_accounts' }).then((accounts) => {
      if (accounts[0]) setWalletAddress(accounts[0]);
    }).catch(() => null);

    void window.ethereum.request<string>({ method: 'eth_chainId' }).then((hex) => {
      const id = parseInt(hex, 16);
      setWalletChainId(id);
      const net = networkByChainId(id);
      if (net) setSelectedNetwork(net.id);
    }).catch(() => null);
  }, []);

  // ── MetaMask: listen for account / chain changes ─────────────────────────

  useEffect(() => {
    if (!window.ethereum) return;

    const onAccountsChanged = (raw: unknown) => {
      const accounts = raw as string[];
      setWalletAddress(accounts[0] ?? null);
    };

    const onChainChanged = (raw: unknown) => {
      const id = parseInt(raw as string, 16);
      setWalletChainId(id);
      resetFhevmInstance(); // reset FHE SDK singleton — keys are chain-specific
      const net = networkByChainId(id);
      if (net) setSelectedNetwork(net.id);
    };

    window.ethereum.on('accountsChanged', onAccountsChanged);
    window.ethereum.on('chainChanged',    onChainChanged);
    return () => {
      window.ethereum?.removeListener('accountsChanged', onAccountsChanged);
      window.ethereum?.removeListener('chainChanged',    onChainChanged);
    };
  }, []);

  // ── Connect wallet ────────────────────────────────────────────────────────

  async function connectWallet() {
    setWalletError(null);
    if (!window.ethereum) {
      setWalletError('MetaMask not detected. Please install the MetaMask extension.');
      return;
    }
    setWalletConnecting(true);
    try {
      // wallet_requestPermissions forces the MetaMask account picker every time,
      // even if the site already has permission (eth_requestAccounts skips it).
      await window.ethereum.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
      const accounts = await window.ethereum.request<string[]>({ method: 'eth_accounts' });
      setWalletAddress(accounts[0] ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection rejected';
      setWalletError(msg.toLowerCase().includes('reject') ? 'Connection rejected.' : msg);
    } finally {
      setWalletConnecting(false);
    }
  }

  function disconnectWallet() {
    setWalletAddress(null);
    setResult(null);
    setLogs([]);
    setFeatures([]);
    setDecryptedScore(null);
    setDecryptError(null);
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────

  async function handleDecrypt() {
    if (!walletAddress || !result || !walletChainId || !contractAddress) return;
    const contractAddr = contractAddress;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const score = await decryptAnomalyScore({
        chainId:         walletChainId,
        userAddress:     walletAddress as `0x${string}`,
        contractAddress: contractAddr,
        handle:          result.encryptedScore as `0x${string}`,
      });
      setDecryptedScore(score);
    } catch (err) {
      setDecryptError(err instanceof Error ? err.message : 'Decryption failed');
    } finally {
      setDecrypting(false);
    }
  }

  // ── Scan ──────────────────────────────────────────────────────────────────

  function appendLog(entry: LogEntry) { setLogs((prev) => [...prev, entry]); }

  async function startScan() {
    if (!walletAddress || scanning) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setScanning(true);
    setLogs([]);
    setFeatures([]);
    setResult(null);
    setDecryptedScore(null);
    setDecryptError(null);

    try {
      const res = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ target: walletAddress, network: selectedNetwork, enabledConnectors: ['fhevm'] }),
        signal:  controller.signal,
      });

      if (!res.ok || !res.body) { appendLog(makeLog('error', `HTTP ${res.status}: ${res.statusText}`)); return; }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
          handleSseEvent(ev);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') appendLog(makeLog('error', err.message));
    } finally {
      setScanning(false);
    }
  }

  function handleSseEvent(ev: Record<string, unknown>) {
    switch (ev.type as string) {
      case 'scan_start':
        appendLog(makeLog('start', `Scanning ${shortAddr(ev.subject as string)} on ${selectedNetwork}`));
        break;
      case 'fetch_done':
        appendLog(makeLog('fetch', `[${ev.connectorId as string}] data fetched`, ev.durationMs as number));
        break;
      case 'fetch_error':
        appendLog(makeLog('error', `[${ev.connectorId as string}] ${(ev.error as { message?: string })?.message ?? 'fetch error'}`));
        break;
      case 'features_merged': {
        const feats   = ev.features as Record<string, number>;
        const entries = Object.entries(feats).map(([key, value]) => ({ key, value }));
        setFeatures(entries);
        appendLog(makeLog('info', `${entries.length} features collected & merged`));
        break;
      }
      case 'encrypt_done':
        appendLog(makeLog('encrypt', 'Features encrypted under FHE', ev.durationMs as number));
        break;
      case 'predict_done':
        appendLog(makeLog('predict', `Inference: ${ev.label as string}`, ev.durationMs as number));
        break;
      case 'scan_complete': {
        const r = ev.result as ScanResult;
        setResult(r);
        appendLog(makeLog('success', `Complete — ${r.label}`));
        break;
      }
      case 'error':
        appendLog(makeLog('error', (ev.message as string) ?? 'Unknown error'));
        break;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-mono overflow-hidden">

      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-zinc-800/80 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
          <span className="text-sm font-black tracking-widest text-zinc-100 uppercase">FHE Agent Guard</span>
        </div>
        <div className="flex items-center gap-5">
          <StatusDot ok={health.inference} label="inference" />
          <StatusDot ok={health.rpc}       label="rpc" />
          <span className={`text-[10px] px-2 py-0.5 rounded border uppercase tracking-widest ${activeNetwork.color} ${activeNetwork.border}`}>
            {health.network ?? activeNetwork.shortLabel}
          </span>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">

        {/* Left Panel */}
        <aside className="flex-shrink-0 w-[320px] border-r border-zinc-800/80 flex flex-col overflow-y-auto bg-zinc-950/60">
          <div className="p-4 space-y-5 flex-1">

            {/* Wallet */}
            <section>
              <label className="block text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Your Wallet</label>
              {walletAddress ? (
                <div className="rounded border border-emerald-500/40 bg-emerald-950/20 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-emerald-400 uppercase tracking-widest">Connected</span>
                    <button onClick={disconnectWallet} className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors">
                      Disconnect
                    </button>
                  </div>
                  <p className="text-xs text-zinc-200 break-all font-mono">{walletAddress}</p>
                  {walletChainId && (
                    <p className="text-[10px] text-zinc-600 mt-1">
                      MetaMask chain: {networkByChainId(walletChainId)?.label ?? `chain ${walletChainId}`}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <button
                    onClick={() => { void connectWallet(); }}
                    disabled={walletConnecting}
                    className="w-full py-2.5 rounded border border-zinc-600 text-xs font-semibold text-zinc-300
                               hover:border-zinc-400 hover:text-zinc-100 transition-all duration-150
                               flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-wait"
                  >
                    {walletConnecting ? (
                      <>
                        <span className="inline-block w-3 h-3 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin" />
                        Connecting…
                      </>
                    ) : (
                      <><span className="text-base leading-none">🦊</span> Connect MetaMask</>
                    )}
                  </button>
                  {walletError && <p className="text-[10px] text-red-400 leading-relaxed">{walletError}</p>}
                  <p className="text-[10px] text-zinc-600 leading-relaxed">
                    Only your own wallet can be scanned. Your data is encrypted before analysis.
                  </p>
                </div>
              )}
            </section>

            {/* Network selector */}
            <section>
              <label className="block text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Network</label>
              <div className="space-y-1.5">
                {NETWORKS.map((net) => (
                  <button
                    key={net.id}
                    onClick={() => setSelectedNetwork(net.id)}
                    className={`w-full text-left px-3 py-2 rounded border text-xs transition-all duration-150 ${
                      selectedNetwork === net.id
                        ? `${net.border} ${net.bg} ${net.color}`
                        : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{net.label}</span>
                      <div className="flex items-center gap-2">
                        {isFheSupported(net.chainId) && (
                          <span className="text-[8px] uppercase tracking-widest text-violet-500 border border-violet-700/50 px-1 rounded">fhe</span>
                        )}
                        {selectedNetwork === net.id && (
                          <span className="text-[9px] uppercase tracking-widest opacity-70">active</span>
                        )}
                      </div>
                    </div>
                    <div className="text-[10px] opacity-60 mt-0.5">chain {net.chainId}</div>
                  </button>
                ))}
              </div>
            </section>

            {/* Collected features */}
            {features.length > 0 && (
              <section>
                <label className="block text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Collected Features</label>
                <div className="rounded border border-zinc-800 bg-zinc-900/40 divide-y divide-zinc-800/60">
                  {features.map(({ key, value }) => (
                    <div key={key} className="flex items-center justify-between px-3 py-1.5">
                      <span className="text-[10px] text-zinc-400 truncate pr-2">{FEATURE_LABELS[key] ?? key}</span>
                      <span className="text-[10px] text-emerald-400 font-mono flex-shrink-0 tabular-nums">{value.toFixed(4)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-zinc-600 mt-1.5 italic">encrypted before leaving client</p>
              </section>
            )}
          </div>

          {/* Scan button */}
          <div className="p-4 border-t border-zinc-800/80 flex-shrink-0">
            {!walletAddress ? (
              <div className="w-full py-3 rounded border border-zinc-800 text-xs text-zinc-600 text-center">
                Connect wallet to scan
              </div>
            ) : (
              <button
                onClick={() => { void startScan(); }}
                disabled={!walletAddress || scanning}
                className={`w-full py-3 rounded border text-xs font-black uppercase tracking-widest transition-all duration-150 flex items-center justify-center gap-2 ${
                  scanning
                    ? 'border-emerald-600/50 text-emerald-600 cursor-wait'
                    : 'border-emerald-500 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 hover:border-emerald-400'
                }`}
              >
                {scanning ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                    Scanning…
                  </>
                ) : 'Scan My Wallet'}
              </button>
            )}
          </div>
        </aside>

        {/* Right Panel */}
        <main className="flex flex-1 flex-col min-w-0 min-h-0">
          <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-zinc-800/80 bg-zinc-950/40">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">Live Events</span>
            {scanning && (
              <span className="flex items-center gap-1.5 text-[10px] text-amber-400">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                scanning
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto py-2 min-h-0">
            {logs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-zinc-700 text-xs">
                {walletAddress ? 'Select a network and click Scan My Wallet' : 'Connect your MetaMask wallet to get started'}
              </div>
            ) : (
              logs.map((entry) => <LogLine key={entry.id} entry={entry} />)
            )}
            <div ref={logBottomRef} />
          </div>

          {result && (
            <ResultPanel
              result={result}
              canDecrypt={fheDecryptReady}
              contractAddress={contractAddress}
              walletAddress={walletAddress ?? ''}
              chainId={walletChainId ?? 0}
              decryptedScore={decryptedScore}
              decrypting={decrypting}
              decryptError={decryptError}
              onDecrypt={() => { void handleDecrypt(); }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
