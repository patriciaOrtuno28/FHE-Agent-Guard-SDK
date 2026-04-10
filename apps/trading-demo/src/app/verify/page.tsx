'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useFheGuard } from '@fhe-guard/plugin';
import { getWalletAddress, getUsername, isLoggedIn, logout, markScanned } from '@/lib/auth';

const REQUIRED_SCORE = Number(process.env.NEXT_PUBLIC_REQUIRED_SCORE ?? 7);

const STEPS: { key: string; label: string }[] = [
  { key: 'scanning',   label: 'Connecting to network' },
  { key: 'fetching',   label: 'Fetching on-chain activity' },
  { key: 'encrypting', label: 'Encrypting features with FHE' },
  { key: 'predicting', label: 'Running encrypted inference' },
  { key: 'complete',   label: 'Trust score computed' },
];

function stepIndex(status: string): number {
  return STEPS.findIndex((s) => s.key === status);
}

export default function VerifyPage() {
  const router    = useRouter();
  const { scan, status, score, isAllowed, isLoading, error, threshold } = useFheGuard();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace('/login');
      return;
    }
    // Start scan once
    if (!startedRef.current && status === 'idle') {
      startedRef.current = true;
      const wallet = getWalletAddress();
      if (wallet) void scan(wallet);
    }
  }, [router, scan, status]);

  // When scan completes and access is granted, redirect after a short delay
  useEffect(() => {
    if (status === 'complete' && isAllowed) {
      markScanned();
      const timer = setTimeout(() => router.push('/dashboard'), 1800);
      return () => clearTimeout(timer);
    }
  }, [status, isAllowed, router]);

  const currentStep = stepIndex(status);
  const username    = getUsername() ?? 'Trader';
  const wallet      = getWalletAddress();

  function handleLogout() {
    logout();
    router.push('/');
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">

      {/* Logout */}
      <button
        onClick={handleLogout}
        className="absolute top-6 right-6 text-slate-600 hover:text-slate-400 text-sm transition-colors"
      >
        Sign out
      </button>

      <div className="w-full max-w-lg space-y-6 animate-fade-in">

        {/* Header */}
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-emerald-400 font-black text-2xl">FHE</span>
            <span className="text-slate-100 font-black text-2xl">TradeSafe</span>
          </div>
          <h1 className="text-xl font-black text-slate-100">
            Verifying Trust Score
          </h1>
          <p className="text-slate-500 text-sm">
            Hello, <span className="text-slate-300">{username}</span>. Analysing your on-chain activity under FHE…
          </p>
        </div>

        {/* Threshold notice */}
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

        {/* Progress card */}
        <div className="card space-y-4">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
            FHE Scan Progress
          </div>

          <div className="space-y-3">
            {STEPS.map((step, i) => {
              const isDone    = currentStep > i || status === 'complete';
              const isActive  = currentStep === i && isLoading;
              const isPending = !isDone && !isActive;

              return (
                <div key={step.key} className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                    {isDone ? (
                      <span className="text-emerald-400 text-base font-bold">&#10003;</span>
                    ) : isActive ? (
                      <span className="inline-block w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-700" />
                    )}
                  </div>
                  <span className={`text-sm ${isDone ? 'text-emerald-300' : isActive ? 'text-slate-200' : 'text-slate-600'}`}>
                    {step.label}
                    {isActive && <span className="text-slate-500 ml-1.5">…</span>}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Privacy note */}
          <div className="border-t border-slate-800/60 pt-3 mt-2">
            <p className="text-[11px] text-slate-600 leading-relaxed">
              &#9670; All features are encrypted under the Zama KMS public key before analysis.
              No plaintext data is sent to any server.
            </p>
          </div>
        </div>

        {/* Result */}
        {status === 'complete' && (
          <ResultCard
            score={score}
            isAllowed={isAllowed}
            threshold={threshold}
          />
        )}

        {status === 'error' && (
          <ErrorCard message={error} onRetry={() => {
            startedRef.current = false;
            const w = getWalletAddress();
            if (w) void scan(w);
          }} />
        )}
      </div>
    </div>
  );
}

function ResultCard({ score, isAllowed, threshold }: { score: number | null; isAllowed: boolean; threshold: number }) {
  const scoreDisplay = score !== null ? score.toFixed(1) : '–';

  if (isAllowed) {
    return (
      <div className="card border-emerald-500/30 bg-emerald-950/20 shadow-[0_0_30px_rgba(16,185,129,0.1)] space-y-3 animate-fade-in">
        <div className="flex items-center gap-3">
          <span className="text-3xl text-emerald-400">&#10003;</span>
          <div>
            <div className="font-black text-emerald-300 text-lg">Access Granted</div>
            <div className="text-sm text-emerald-400/70">Redirecting to dashboard…</div>
          </div>
          <div className="ml-auto text-right">
            <div className="text-3xl font-black text-emerald-300">{scoreDisplay}/10</div>
            <div className="text-[11px] text-slate-500">Trust Score</div>
          </div>
        </div>
        <div className="text-xs text-emerald-400/60">
          Your score meets the required threshold of {threshold}/10.
        </div>
      </div>
    );
  }

  return (
    <div className="card border-red-500/30 bg-red-950/20 shadow-[0_0_30px_rgba(239,68,68,0.1)] space-y-4 animate-fade-in">
      <div className="flex items-center gap-3">
        <span className="text-3xl text-red-400">&#10007;</span>
        <div>
          <div className="font-black text-red-300 text-lg">Access Denied</div>
          <div className="text-sm text-red-400/70">Your trust score is below the required threshold</div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-3xl font-black text-red-300">{scoreDisplay}/10</div>
          <div className="text-[11px] text-slate-500">Trust Score</div>
        </div>
      </div>

      <div className="space-y-1 text-sm text-slate-400 border-t border-red-900/40 pt-3">
        <p>
          The platform requires a score of{' '}
          <span className="font-bold text-slate-300">{threshold}/10</span>.
          Your current score of{' '}
          <span className="font-bold text-red-300">{scoreDisplay}/10</span>{' '}
          does not meet this requirement.
        </p>
        <p className="text-slate-500 text-xs">
          Build a stronger on-chain history and try again, or contact support for more information.
        </p>
      </div>

      <Link
        href="/"
        className="btn-secondary text-sm inline-flex items-center gap-2 w-full justify-center"
      >
        Return to Home
      </Link>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="card border-amber-500/30 bg-amber-950/20 space-y-3 animate-fade-in">
      <div className="flex items-center gap-2 text-amber-300">
        <span className="text-xl">&#9888;</span>
        <span className="font-bold">Scan Error</span>
      </div>
      <p className="text-sm text-slate-400">{message ?? 'An unexpected error occurred during the scan.'}</p>
      <p className="text-xs text-slate-600">
        Make sure the inference server is running and your wallet address is valid on Sepolia.
      </p>
      <button onClick={onRetry} className="btn-secondary text-sm">
        Retry Scan
      </button>
    </div>
  );
}
