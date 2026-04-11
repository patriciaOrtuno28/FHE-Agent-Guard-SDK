'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { encodeFunctionData, getAddress } from 'viem';
import type { Hex } from 'viem';
import { useFheGuard, encryptUint64, decryptAnomalyScore, isFheSupported, resetFhevmInstance } from '@fhe-guard/plugin';
import { getWalletAddress, getUsername, isLoggedIn, logout, markScanned } from '@/lib/auth';

declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
      on(event: string, handler: (...args: unknown[]) => void): void;
      removeListener(event: string, handler: (...args: unknown[]) => void): void;
    };
  }
}

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_TRUST_SCORE_AGENT_SEPOLIA as `0x${string}` | undefined;

const SCAN_STEPS: { key: string; label: string }[] = [
  { key: 'scanning',   label: 'Connecting to network' },
  { key: 'fetching',   label: 'Fetching on-chain activity' },
  { key: 'encrypting', label: 'Encrypting features with FHE' },
  { key: 'predicting', label: 'Running encrypted inference' },
  { key: 'complete',   label: 'Trust score computed' },
];

function scanStepIndex(status: string): number {
  return SCAN_STEPS.findIndex((s) => s.key === status);
}

export default function VerifyPage() {
  const router = useRouter();
  const { scan, status, score, isAllowed, isLoading, error, threshold } = useFheGuard();
  const scanStarted = useRef(false);

  // ── MetaMask chain ───────────────────────────────────────────────────────
  const [chainId, setChainId] = useState<number | null>(null);

  useEffect(() => {
    if (!window.ethereum) return;
    void window.ethereum.request<string>({ method: 'eth_chainId' })
      .then((hex) => setChainId(parseInt(hex, 16)))
      .catch(() => null);

    const onChainChanged = (raw: unknown) => {
      setChainId(parseInt(raw as string, 16));
      resetFhevmInstance();
      setRealFheHandle(null); setRealFheProof(null); setFheContext(null);
      setSubmitted(false); setDecryptedScore(null);
    };
    window.ethereum.on('chainChanged', onChainChanged);
    return () => window.ethereum?.removeListener('chainChanged', onChainChanged);
  }, []);

  // ── FHE client-side encryption ───────────────────────────────────────────
  const [realFheHandle,  setRealFheHandle]  = useState<string | null>(null);
  const [realFheProof,   setRealFheProof]   = useState<string | null>(null);
  const [fheEncrypting,  setFheEncrypting]  = useState(false);
  const [fheError,       setFheError]       = useState<string | null>(null);

  type FheContext = { chainId: number; contractAddress: `0x${string}`; userAddress: `0x${string}` };
  const [fheContext, setFheContext] = useState<FheContext | null>(null);

  // ── On-chain submission ──────────────────────────────────────────────────
  const [submitting,   setSubmitting]   = useState(false);
  const [submitted,    setSubmitted]    = useState(false);
  const [submitError,  setSubmitError]  = useState<string | null>(null);

  // ── KMS decryption ───────────────────────────────────────────────────────
  const [decryptedScore, setDecryptedScore] = useState<bigint | null>(null);
  const [decrypting,     setDecrypting]     = useState(false);
  const [decryptError,   setDecryptError]   = useState<string | null>(null);

  const [wallet,          setWallet]          = useState<string | null>(null);
  const [username,        setUsername]        = useState('Trader');
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  useEffect(() => {
    setWallet(getWalletAddress());
    void getUsername().then((name) => setUsername(name ?? 'Trader'));
    setAlreadySubmitted(!!localStorage.getItem('lastSubmittedFheHandle'));
  }, []);

  const canFhe = chainId !== null && isFheSupported(chainId) && !!CONTRACT_ADDRESS && !!wallet;

  // ── Auth guard ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoggedIn()) { router.replace('/'); return; }
    if (!scanStarted.current && status === 'idle' && wallet) {
      scanStarted.current = true;
      void scan(wallet);
    }
  }, [router, scan, status, wallet]);

  // ── Auto-encrypt after scan completes ───────────────────────────────────
  const handleClientEncrypt = useCallback(async (rawScore: number) => {
    if (!canFhe || !wallet || !CONTRACT_ADDRESS || !chainId) return;
    setFheEncrypting(true);
    setFheError(null);
    try {
      const userAddress     = getAddress(wallet) as `0x${string}`;
      const contractAddress = getAddress(CONTRACT_ADDRESS) as `0x${string}`;
      const { handle, inputProof } = await encryptUint64({
        chainId,
        contractAddress,
        userAddress,
        value: BigInt(Math.round(rawScore)),
      });
      setRealFheHandle(handle);
      setRealFheProof(inputProof);
      setFheContext({ chainId, contractAddress, userAddress });
      localStorage.setItem('lastFheHandle', handle);
    } catch (err) {
      setFheError(err instanceof Error ? err.message : 'FHE encryption failed');
    } finally {
      setFheEncrypting(false);
    }
  }, [canFhe, wallet, chainId]);

  useEffect(() => {
    if (status === 'complete' && score !== null && canFhe) {
      void handleClientEncrypt(score);
    }
  }, [status, score, canFhe, handleClientEncrypt]);

  // Persist scan result so the dashboard can skip re-verification on return visits.
  useEffect(() => {
    if (status === 'complete' && score !== null) {
      localStorage.setItem('fheguard_td_score',   score.toString());
      localStorage.setItem('fheguard_td_allowed',  isAllowed ? '1' : '0');
    }
  }, [status, score, isAllowed]);

  // ── On-chain submission ──────────────────────────────────────────────────
  async function handleSubmitOnChain() {
    if (!wallet || !CONTRACT_ADDRESS || !realFheHandle || !realFheProof || !fheContext || !chainId) return;
    if (!window.ethereum) return;

    const userAddress     = getAddress(wallet) as `0x${string}`;
    const contractAddress = getAddress(CONTRACT_ADDRESS) as `0x${string}`;

    if (
      fheContext.chainId !== chainId ||
      fheContext.userAddress.toLowerCase() !== userAddress.toLowerCase() ||
      fheContext.contractAddress.toLowerCase() !== contractAddress.toLowerCase()
    ) {
      setSubmitError('Proof is stale — re-run the scan before submitting.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const data = encodeFunctionData({
        abi: [{
          name: 'registerMyScore',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'encScore',   type: 'bytes32' },
            { name: 'inputProof', type: 'bytes' },
          ],
          outputs: [],
        }] as const,
        functionName: 'registerMyScore',
        args: [realFheHandle as `0x${string}`, realFheProof as `0x${string}`],
      });

      const txHash = await window.ethereum.request<string>({
        method: 'eth_sendTransaction',
        params: [{ from: wallet, to: CONTRACT_ADDRESS, data, gas: '0x2DC6C0' }],
      });

      await waitForReceipt(txHash as string);
      // ACL is now granted — record the confirmed handle separately
      localStorage.setItem('lastSubmittedFheHandle', realFheHandle as string);
      setAlreadySubmitted(true);
      setSubmitted(true);
      markScanned();
    } catch (err) {
      const e = err as { message?: string; reason?: string };
      setSubmitError(String(e.reason ?? e.message ?? 'Transaction failed'));
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
        if (receipt.status === '0x0') throw new Error('Transaction reverted on-chain.');
        return;
      }
    }
    throw new Error('Transaction not mined within 2 minutes.');
  }

  // ── KMS decryption ───────────────────────────────────────────────────────
  async function handleDecrypt() {
    if (!wallet || !CONTRACT_ADDRESS || !realFheHandle || !chainId) return;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const value = await decryptAnomalyScore({
        chainId,
        userAddress:     getAddress(wallet) as `0x${string}`,
        contractAddress: getAddress(CONTRACT_ADDRESS) as `0x${string}`,
        handle:          realFheHandle as Hex,
      });
      setDecryptedScore(value);
    } catch (err) {
      setDecryptError(err instanceof Error ? err.message : 'Decryption failed');
    } finally {
      setDecrypting(false);
    }
  }

  function handleLogout() { logout(); router.push('/'); }

  // ── Render ───────────────────────────────────────────────────────────────
  const currentStep = scanStepIndex(status);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">

      <button onClick={handleLogout} className="absolute top-6 right-6 text-slate-600 hover:text-slate-400 text-sm transition-colors">
        Sign out
      </button>

      <div className="w-full max-w-lg space-y-4 animate-fade-in">

        {/* Header */}
        <div className="text-center space-y-1 mb-2">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-emerald-400 font-black text-2xl">FHE</span>
            <span className="text-slate-100 font-black text-2xl">TradeSafe</span>
          </div>
          <h1 className="text-xl font-black text-slate-100">Verifying Trust Score</h1>
          <p className="text-slate-500 text-sm">
            Hello, <span className="text-slate-300 font-semibold">{username}</span>. Analysing your on-chain activity under FHE…
          </p>
        </div>

        {/* Threshold */}
        <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-slate-700/60 bg-slate-800/30">
          <span className="text-sm text-slate-400">Required score to access trading</span>
          <span className="font-black text-emerald-300 text-lg">{threshold}/10</span>
        </div>

        {/* Wallet */}
        {wallet && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800/20 border border-slate-700/40">
            <span className="text-[11px] text-slate-500 uppercase tracking-wide flex-shrink-0">Wallet</span>
            <span className="text-xs text-slate-400 font-mono truncate">{wallet}</span>
          </div>
        )}

        {/* ── Scan progress ── */}
        <div className="card space-y-4">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-widest">FHE Scan Progress</div>
          <div className="space-y-3">
            {SCAN_STEPS.map((step, i) => {
              const isDone   = currentStep > i || status === 'complete';
              const isActive = currentStep === i && isLoading;
              return (
                <div key={step.key} className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                    {isDone   ? <span className="text-emerald-400 font-bold">&#10003;</span>
                    : isActive ? <span className="inline-block w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                    :            <span className="w-1.5 h-1.5 rounded-full bg-slate-700" />}
                  </div>
                  <span className={`text-sm ${isDone ? 'text-emerald-300' : isActive ? 'text-slate-200' : 'text-slate-600'}`}>
                    {step.label}{isActive && <span className="text-slate-500 ml-1">…</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="border-t border-slate-800/60 pt-3">
            <p className="text-[11px] text-slate-600 leading-relaxed">
              ◈ All features are encrypted under the Zama KMS public key before analysis. No plaintext data is sent to any server.
            </p>
          </div>
        </div>

        {/* ── Scan error ── */}
        {status === 'error' && (
          <div className="card border-amber-500/30 bg-amber-950/20 space-y-3">
            <div className="flex items-center gap-2 text-amber-300">
              <span className="text-xl">&#9888;</span>
              <span className="font-bold">Scan Error</span>
            </div>
            <p className="text-sm text-slate-400">{error ?? 'An unexpected error occurred.'}</p>
            <p className="text-xs text-slate-600">Make sure the inference server is running and your wallet address is valid on Sepolia.</p>
            <button onClick={() => { scanStarted.current = false; if (wallet) void scan(wallet); }} className="btn-secondary text-sm">
              Retry Scan
            </button>
          </div>
        )}

        {/* ── Access result ── */}
        {status === 'complete' && (
          <AccessResultCard
            score={score}
            isAllowed={isAllowed}
            threshold={threshold}
            canEnter={alreadySubmitted || !canFhe}
            onEnter={() => router.push('/dashboard')}
          />
        )}

        {/* ── FHE on-chain verification ── */}
        {status === 'complete' && score !== null && (
          <div className="card space-y-4">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
              FHE On-Chain Verification
            </div>

            {!canFhe ? (
              <p className="text-xs text-slate-600 leading-relaxed">
                Switch MetaMask to <span className="text-violet-400">Sepolia</span> to enable on-chain FHE submission and KMS decryption.
              </p>
            ) : (
              <div className="space-y-4">

                {/* Step 1 — FHE handle */}
                <div className="space-y-1.5">
                  <div className="text-xs text-slate-500 uppercase tracking-wide">Step 1 — Client-side FHE Encryption</div>
                  {fheEncrypting ? (
                    <div className="flex items-center gap-2 text-sm text-fuchsia-400">
                      <span className="inline-block w-3.5 h-3.5 border-2 border-fuchsia-400 border-t-transparent rounded-full animate-spin" />
                      Encrypting score with Zama KMS public key…
                    </div>
                  ) : realFheHandle ? (
                    <div className="space-y-1">
                      <div className="flex items-start gap-2">
                        <span className="text-[10px] text-slate-500 uppercase tracking-wide flex-shrink-0 mt-0.5 w-16">FHE Handle</span>
                        <span className="text-xs text-fuchsia-400 font-mono break-all">{realFheHandle}</span>
                      </div>
                    </div>
                  ) : fheError ? (
                    <p className="text-xs text-red-400">{fheError}</p>
                  ) : null}
                </div>

                {/* Step 2 — Submit on-chain */}
                {realFheHandle && !submitted && (
                  <div className="space-y-2 border-t border-slate-800/60 pt-3">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Step 2 — Submit Encrypted Score On-Chain</div>
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      Submit your encrypted score to <span className="font-mono text-slate-500">AnomalyAgent</span>. The contract stores it under FHE and grants your address KMS ACL permission.
                    </p>
                    <button
                      onClick={handleSubmitOnChain}
                      disabled={submitting}
                      className="w-full py-2 rounded-lg border border-fuchsia-500/40 text-fuchsia-300 text-xs font-semibold
                                 hover:bg-fuchsia-500/10 hover:border-fuchsia-400 transition-all
                                 disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2"
                    >
                      {submitting ? (
                        <><span className="inline-block w-3.5 h-3.5 border-2 border-fuchsia-400 border-t-transparent rounded-full animate-spin" />Submitting…</>
                      ) : (
                        '⛓ Submit Score On-Chain'
                      )}
                    </button>
                    {submitError && <p className="text-[11px] text-red-400">{submitError}</p>}
                  </div>
                )}

                {/* Step 3 — Decrypt */}
                {submitted && decryptedScore === null && (
                  <div className="space-y-2 border-t border-slate-800/60 pt-3">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Step 3 — Decrypt via Zama KMS</div>
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      Score recorded on-chain. Sign with MetaMask to authorise the Zama KMS to decrypt and reveal your score.
                    </p>
                    <button
                      onClick={handleDecrypt}
                      disabled={decrypting}
                      className="w-full py-2 rounded-lg border border-violet-500/40 text-violet-300 text-xs font-semibold
                                 hover:bg-violet-500/10 hover:border-violet-400 transition-all
                                 disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2"
                    >
                      {decrypting ? (
                        <><span className="inline-block w-3.5 h-3.5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />Signing & decrypting…</>
                      ) : (
                        '🔓 Decrypt My Score'
                      )}
                    </button>
                    {decryptError && <p className="text-[11px] text-red-400">{decryptError}</p>}
                  </div>
                )}

                {/* Decrypted result */}
                {decryptedScore !== null && (
                  <div className="border-t border-slate-800/60 pt-3 flex items-center justify-between">
                    <div className="space-y-0.5">
                      <div className="text-xs text-slate-500 uppercase tracking-wide">Decrypted Score (KMS verified)</div>
                      <div className="text-xs text-slate-600">Plaintext confirmed by Zama KMS — proof of on-chain FHE computation</div>
                    </div>
                    <span className="text-2xl font-black text-emerald-300 font-mono ml-4">{decryptedScore.toString()}/10</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AccessResultCard({
  score, isAllowed, threshold, canEnter, onEnter,
}: {
  score: number | null;
  isAllowed: boolean;
  threshold: number;
  canEnter: boolean;
  onEnter: () => void;
}) {
  const display = score !== null ? score.toFixed(1) : '–';

  if (isAllowed) {
    return (
      <div className="card border-emerald-500/30 bg-emerald-950/20 shadow-[0_0_30px_rgba(16,185,129,0.1)] space-y-3 animate-fade-in">
        <div className="flex items-center gap-3">
          <span className="text-3xl text-emerald-400">&#10003;</span>
          <div className="flex-1">
            <div className="font-black text-emerald-300 text-lg">Access Granted</div>
            <div className="text-sm text-emerald-400/70">Your trust score meets the required threshold</div>
          </div>
          <div className="text-right">
            <div className="text-3xl font-black text-emerald-300 font-mono">{display}/10</div>
            <div className="text-[11px] text-slate-500">Trust Score</div>
          </div>
        </div>
        {canEnter ? (
          <button onClick={onEnter} className="btn-primary w-full text-sm">
            Enter Trading Dashboard →
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-950/40 border border-violet-500/30 text-xs text-violet-300">
              <span className="text-base">&#128274;</span>
              One more step — submit your encrypted score on-chain below to unlock the dashboard.
            </div>
            <button disabled className="btn-primary w-full text-sm opacity-40 cursor-not-allowed">
              Enter Trading Dashboard →
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card border-red-500/30 bg-red-950/20 shadow-[0_0_30px_rgba(239,68,68,0.1)] space-y-3 animate-fade-in">
      <div className="flex items-center gap-3">
        <span className="text-3xl text-red-400">&#10007;</span>
        <div className="flex-1">
          <div className="font-black text-red-300 text-lg">Access Denied</div>
          <div className="text-sm text-red-400/70">Your trust score is below the required threshold</div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black text-red-300 font-mono">{display}/10</div>
          <div className="text-[11px] text-slate-500">Trust Score</div>
        </div>
      </div>
      <p className="text-sm text-slate-400 border-t border-red-900/40 pt-3">
        The platform requires a score of <span className="font-bold text-slate-300">{threshold}/10</span>.{' '}
        Your current score of <span className="font-bold text-red-300">{display}/10</span> does not meet this requirement.
      </p>
    </div>
  );
}
