'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeFunctionData, getAddress } from 'viem';
import { NETWORKS, networkByChainId, type NetworkId } from '../lib/networks';
import { decryptAnomalyScore, encryptUint64, isFheSupported, resetFhevmInstance } from '../lib/fhe';
import { clear } from 'node:console';
import { sdkByChainId } from '@fhe-guard/sdk';

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
// Addresses come from .env.local — never hardcode them here.
// Set NEXT_PUBLIC_ANOMALY_AGENT_SEPOLIA and NEXT_PUBLIC_ANOMALY_AGENT_LOCALHOST
// in apps/demo/.env.local (see .env.example for the values).

const exportedSepoliaAddress =
  sdkByChainId[11155111]?.addresses?.AnomalyAgent as `0x${string}` | undefined;

const ANOMALY_AGENT_ADDRESS: Partial<Record<number, `0x${string}`>> = {
  11155111: process.env.NEXT_PUBLIC_ANOMALY_AGENT_SEPOLIA as `0x${string}` | undefined,
} as Partial<Record<number, `0x${string}`>>;

// ── Types ────────────────────────────────────────────────────────────────────

type LogKind = 'start' | 'success' | 'error' | 'encrypt' | 'fhe_client' | 'predict' | 'fetch' | 'info';

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
  rawPrediction?: number | null;
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
    case 'start':      return '▶';
    case 'success':    return '✓';
    case 'error':      return '✗';
    case 'encrypt':    return '🔒';
    case 'fhe_client': return '⚿';
    case 'predict':    return '◈';
    case 'fetch':      return '↓';
    case 'info':       return '·';
  }
}

function logColor(kind: LogKind): string {
  switch (kind) {
    case 'start':      return 'text-blue-400';
    case 'success':    return 'text-emerald-400';
    case 'error':      return 'text-red-400';
    case 'encrypt':    return 'text-violet-400';
    case 'fhe_client': return 'text-fuchsia-400';
    case 'predict':    return 'text-amber-400';
    case 'fetch':      return 'text-zinc-400';
    case 'info':       return 'text-zinc-500';
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
  chainId,
  realFheHandle,
  fheEncrypting,
  submitting,
  submitted,
  submitError,
  decryptedScore,
  decrypting,
  decryptError,
  onSubmit,
  onDecrypt,
}: {
  result: ScanResult;
  canDecrypt: boolean;
  contractAddress?: `0x${string}`;
  chainId: number;
  realFheHandle: string | null;
  fheEncrypting: boolean;
  submitting: boolean;
  submitted: boolean;
  submitError: string | null;
  decryptedScore: bigint | null;
  decrypting: boolean;
  decryptError: string | null;
  onSubmit: () => void;
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
        {realFheHandle ? (
          <div className="flex items-start gap-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wide flex-shrink-0 mt-0.5 w-28">FHE Handle</span>
            <span className="text-xs text-fuchsia-400 font-mono break-all">{realFheHandle}</span>
          </div>
        ) : fheEncrypting ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wide flex-shrink-0 w-28">FHE Handle</span>
            <span className="flex items-center gap-1.5 text-xs text-fuchsia-500">
              <span className="inline-block w-3 h-3 border-2 border-fuchsia-500 border-t-transparent rounded-full animate-spin" />
              encrypting with KMS key…
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wide flex-shrink-0 mt-0.5 w-28">Score (mock)</span>
            <span className="text-xs text-violet-400/60 font-mono break-all">{result.encryptedScore}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide flex-shrink-0 w-28">Is Anomaly</span>
          <span className="text-xs text-violet-400 font-mono">{result.isAnomaly}</span>
        </div>
      </div>

      {/* On-chain submit + Decryption */}
      {canDecrypt && contractAddress ? (
        <div className="border-t border-zinc-800/60 pt-3 mt-3 flex flex-col gap-2">
          {decryptedScore !== null ? (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide w-28 flex-shrink-0">Decrypted Score</span>
              <span className="text-sm font-black text-emerald-300 font-mono">{decryptedScore.toString()}</span>
            </div>
          ) : (
            <>
              {/* Step 1 — submit score on-chain so the ACL is set */}
              {!submitted ? (
                <>
                  <p className="text-[10px] text-zinc-500 leading-relaxed">
                    Submit your encrypted score on-chain. The contract runs the FHE comparison
                    and grants your address permission to decrypt the result via the Zama KMS.
                  </p>
                  <button
                    onClick={onSubmit}
                    disabled={submitting || !realFheHandle}
                    className="w-full py-2 rounded border border-fuchsia-500/50 text-fuchsia-400 text-xs font-semibold
                               hover:bg-fuchsia-500/10 hover:border-fuchsia-400 transition-all duration-150
                               disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2"
                  >
                    {submitting ? (
                      <>
                        <span className="inline-block w-3 h-3 border-2 border-fuchsia-500 border-t-transparent rounded-full animate-spin" />
                        Submitting…
                      </>
                    ) : (
                      '⛓ Submit Score On-Chain'
                    )}
                  </button>
                  {submitError && (
                    <p className="text-[10px] text-red-400 leading-relaxed">{submitError}</p>
                  )}
                </>
              ) : (
                /* Step 2 — score is on-chain, ACL granted, now decrypt */
                <>
                  <p className="text-[10px] text-zinc-500 leading-relaxed">
                    Score recorded on-chain. Sign with MetaMask to decrypt your anomaly score —
                    the KMS verifies the on-chain ACL before revealing the plaintext.
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
                </>
              )}
            </>
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

  // Client-side FHE encryption (browser → Zama KMS public key → real handle)
  const [realFheHandle,  setRealFheHandle]  = useState<string | null>(null);
  const [realFheProof,   setRealFheProof]   = useState<string | null>(null);
  const [fheEncrypting,  setFheEncrypting]  = useState(false);

  // On-chain submission (submitMyScore tx)
  const [submitting,     setSubmitting]     = useState(false);
  const [submitted,      setSubmitted]      = useState(false);
  const [submitError,    setSubmitError]    = useState<string | null>(null);

  // Decryption
  const [decryptedScore, setDecryptedScore] = useState<bigint | null>(null);
  const [decrypting,     setDecrypting]     = useState(false);
  const [decryptError,   setDecryptError]   = useState<string | null>(null);

  // Health
  const [health, setHealth] = useState<HealthState>({ inference: null, rpc: null, network: null });

  const logBottomRef = useRef<HTMLDivElement>(null);
  const abortRef     = useRef<AbortController | null>(null);

  // State to store encryption context
  
  type FheProofContext = {
    chainId: number;
    contractAddress: `0x${string}`;
    userAddress: `0x${string}`;
  };
  
  const [fheProofContext, setFheProofContext] = useState<FheProofContext | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────

  const activeNetwork       = NETWORKS.find((n) => n.id === selectedNetwork)!;
  const rawContractAddress  = walletChainId ? ANOMALY_AGENT_ADDRESS[walletChainId] : undefined;
  const networkLocked       = Boolean(activeNetwork.disabled);

  const contractAddress = rawContractAddress
    ? (getAddress(rawContractAddress) as `0x${string}`)
    : undefined;
  const fheDecryptReady  = walletChainId !== null && isFheSupported(walletChainId);

  // ── Helpers ────────────────────────────────────────────────────────

  function clearFheSubmissionState() {
    setRealFheHandle(null);
    setRealFheProof(null);
    setFheProofContext(null);
    setSubmitting(false);
    setSubmitted(false);
    setSubmitError(null);
    setDecryptedScore(null);
    setDecryptError(null);
  }

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
      if (net && !net.disabled) {
        setSelectedNetwork(net.id);
      } else {
        setSelectedNetwork('sepolia');
      }
    }).catch(() => null);
  }, []);

  // ── MetaMask: listen for account / chain changes ─────────────────────────

  useEffect(() => {
    if (!window.ethereum) return;

    const onAccountsChanged = (raw: unknown) => {
      const accounts = raw as string[];
      setWalletAddress(accounts[0] ? getAddress(accounts[0]) : null);
      clearFheSubmissionState();
    };

    const onChainChanged = (raw: unknown) => {
      const id = parseInt(raw as string, 16);
      setWalletChainId(id);
      resetFhevmInstance(); // reset FHE SDK singleton — keys are chain-specific
      clearFheSubmissionState();

      const net = networkByChainId(id);
      if (net && !net.disabled) {
        setSelectedNetwork(net.id);
      } else {
        setSelectedNetwork('sepolia');
      }
    };

    window.ethereum.on('accountsChanged', onAccountsChanged);
    window.ethereum.on('chainChanged',    onChainChanged);
    return () => {
      window.ethereum?.removeListener('accountsChanged', onAccountsChanged);
      window.ethereum?.removeListener('chainChanged',    onChainChanged);
    };
  }, []);

  // ── Load last FHE handle from local storage in case the user restarted the app ──────

  useEffect(() => {
    const saved = localStorage.getItem('lastFheHandle');
    if (saved) setRealFheHandle(saved);
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
      setWalletAddress(accounts[0] ? getAddress(accounts[0]) : null);
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
    clearFheSubmissionState();
  }

  // ── Client-side FHE encryption ────────────────────────────────────────────
  // After the server returns a rawPrediction (0 or 1), the browser encrypts it
  // using the Zama KMS network public key. This produces a real fhevm handle +
  // inputProof that can be submitted to AnomalyAgent.submitScore() on-chain.

  async function handleClientEncrypt(rawPrediction: number) {
    if (!walletAddress || !walletChainId || !contractAddress) return;

    setFheEncrypting(true);
    try {
      const normalizedUser = getAddress(walletAddress) as `0x${string}`;
      const normalizedContract = getAddress(contractAddress) as `0x${string}`;

      appendLog(makeLog('fhe_client', 'Encrypting score with Zama KMS network public key…'));

      const { handle, inputProof } = await encryptUint64({
        chainId: walletChainId,
        contractAddress: normalizedContract,
        userAddress: normalizedUser,
        value: BigInt(rawPrediction),
      });

      setRealFheHandle(handle);
      setRealFheProof(inputProof);
      setFheProofContext({
        chainId: walletChainId,
        contractAddress: normalizedContract,
        userAddress: normalizedUser,
      });

      localStorage.setItem('lastFheHandle', handle); // persist restarts

      appendLog(makeLog('fhe_client', `Handle: ${handle.slice(0, 20)}… proof: ${inputProof.slice(0, 10)}…`));
    } catch (err) {
      appendLog(makeLog('error', `Client FHE encryption: ${err instanceof Error ? err.message : 'failed'}`));
    } finally {
      setFheEncrypting(false);
    }
  }

  // ── On-chain submission ───────────────────────────────────────────────────

  async function handleSubmitOnChain() {
    if (!walletAddress || !walletChainId || !contractAddress || !realFheHandle || !realFheProof) return;
    if (!window.ethereum) return;

    const currentUser = getAddress(walletAddress) as `0x${string}`;
    const currentContract = getAddress(contractAddress) as `0x${string}`;

    if (
      !fheProofContext ||
      fheProofContext.chainId !== walletChainId ||
      fheProofContext.userAddress.toLowerCase() !== currentUser.toLowerCase() ||
      fheProofContext.contractAddress.toLowerCase() !== currentContract.toLowerCase()
    ) {
      const msg =
        'Encrypted proof is stale. It was generated for a different wallet, chain, or contract. Re-run the scan before submitting.';
      setSubmitError(msg);
      appendLog(makeLog('error', msg));
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      appendLog(makeLog('fhe_client', 'Registering encrypted score on-chain (grants KMS ACL)…'));

      // externalEuint64 is bytes32 at the ABI level
      const data = encodeFunctionData({
        abi: [{
          name: 'registerMyScore',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'encScore',   type: 'bytes32' },
            { name: 'inputProof', type: 'bytes'   },
          ],
          outputs: [],
        }] as const,
        functionName: 'registerMyScore',
        args: [realFheHandle as `0x${string}`, realFheProof as `0x${string}`],
      });

      // fhevm's FHE.fromExternal() reads coprocessor state in ways that cause
      // MetaMask's static-call gas estimation to revert (→ fallback 21M gas → cap error).
      // Set an explicit gas limit to bypass estimation entirely.
      // 1,000,000 gas is a safe upper bound for registerMyScore on Sepolia fhevm.
      const txHash = await window.ethereum.request<string>({
        method: 'eth_sendTransaction',
        params: [{ from: walletAddress, to: contractAddress, data, gas: '0x2DC6C0' }],
      });

      const hash = txHash as string;
      appendLog(makeLog('fhe_client', `Tx: ${hash.slice(0, 14)}… — waiting for confirmation…`));
      await waitForReceipt(hash);

      setSubmitted(true);
      if (realFheHandle) localStorage.setItem('lastFheHandle', realFheHandle);

      appendLog(makeLog('success', 'Score recorded on-chain — ACL granted, ready to decrypt'));
    } catch (err: unknown) {
      // MetaMask throws ProviderRpcError (not a plain Error) — extract message carefully
      let msg = 'Unknown error';
      if (typeof err === 'object' && err !== null) {
        const e = err as { message?: unknown; reason?: unknown; data?: { message?: unknown } };
        msg = String(e.reason ?? e.message ?? e.data?.message ?? JSON.stringify(err));
      } else if (typeof err === 'string') {
        msg = err;
      }
      setSubmitError(msg);
      appendLog(makeLog('error', `On-chain submission: ${msg}`));
    } finally {
      setSubmitting(false);
    }
  }

  async function waitForReceipt(txHash: string, maxWaitMs = 120_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));

      const receipt = await window.ethereum!.request<{ status: string } | null>({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });

      if (receipt) {
        if (receipt.status === '0x0') {
          throw new Error(`Transaction reverted on-chain (tx: ${txHash.slice(0, 12)}…). Check proof context, sender, contract state, or gas limit.`);
        }
        return;
      }
    }

    throw new Error('Transaction not mined within 2 minutes');
  }

  // ── Decrypt ───────────────────────────────────────────────────────────────

  async function handleDecrypt() {
    if (!walletAddress || !result || !walletChainId || !contractAddress) return;

    const contractAddr = contractAddress;
    if (!realFheHandle) throw new Error('No encrypted handle available. Run a fresh scan first.');
    const handle = realFheHandle as `0x${string}`;

    setDecrypting(true);
    setDecryptError(null);

    try {
      const normalizedUser = getAddress(walletAddress) as `0x${string}`;
      const normalizedContract = getAddress(contractAddr) as `0x${string}`;

      const score = await decryptAnomalyScore({
        chainId: walletChainId,
        userAddress: normalizedUser,
        contractAddress: normalizedContract,
        handle,
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
    if (!walletAddress || scanning || networkLocked) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setScanning(true);
    setLogs([]);
    setFeatures([]);
    setResult(null);
    clearFheSubmissionState();

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
        // Kick off client-side FHE encryption on Sepolia when contract is deployed.
        // encryptUint64 requires window.ethereum and the Zama KMS network public key.
        if (r.rawPrediction !== null && r.rawPrediction !== undefined
            && walletChainId && isFheSupported(walletChainId) && contractAddress) {
          void handleClientEncrypt(r.rawPrediction);
        }
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
                {NETWORKS.map((net) => {
                  const isDisabled = Boolean(net.disabled);
                  const isActive = selectedNetwork === net.id && !isDisabled;

                  return (
                    <button
                      key={net.id}
                      onClick={() => {
                        if (!isDisabled) setSelectedNetwork(net.id);
                      }}
                      disabled={isDisabled}
                      className={`w-full text-left px-3 py-2 rounded border text-xs transition-all duration-150 ${
                        isDisabled
                          ? 'border-zinc-800 text-zinc-600 bg-zinc-950/40 cursor-not-allowed opacity-70'
                          : isActive
                            ? `${net.border} ${net.bg} ${net.color}`
                            : 'border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{net.label}</span>
                        <div className="flex items-center gap-2">
                          {net.badge === 'FHE' && (
                            <span className="text-[8px] uppercase tracking-widest text-violet-500 border border-violet-700/50 px-1 rounded">
                              FHE
                            </span>
                          )}
                          {net.badge === 'Coming Soon' && (
                            <span className="text-[8px] uppercase tracking-widest text-amber-400 border border-amber-500/40 px-1 rounded">
                              Coming Soon
                            </span>
                          )}
                          {isActive && (
                            <span className="text-[9px] uppercase tracking-widest opacity-70">active</span>
                          )}
                        </div>
                      </div>

                      <div className="text-[10px] opacity-60 mt-0.5">chain {net.chainId}</div>
                    </button>
                  );
                })}
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
                disabled={!walletAddress || scanning || networkLocked}
                className={`w-full py-3 rounded border text-xs font-black uppercase tracking-widest transition-all duration-150 flex items-center justify-center gap-2 ${
                  scanning
                    ? 'border-emerald-600/50 text-emerald-600 cursor-wait'
                    : 'border-emerald-500 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300 hover:border-emerald-400'
                }`}
              >
                {scanning ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                    Scanning…
                  </>
                ) : networkLocked ? (
                  'Coming Soon'
                ) : (
                  'Scan My Wallet'
                )}
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
              chainId={walletChainId ?? 0}
              realFheHandle={realFheHandle}
              fheEncrypting={fheEncrypting}
              submitting={submitting}
              submitted={submitted}
              submitError={submitError}
              decryptedScore={decryptedScore}
              decrypting={decrypting}
              decryptError={decryptError}
              onSubmit={() => { void handleSubmitOnChain(); }}
              onDecrypt={() => { void handleDecrypt(); }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
