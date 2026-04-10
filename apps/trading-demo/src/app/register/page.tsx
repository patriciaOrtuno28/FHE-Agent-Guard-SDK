'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { login, isLoggedIn } from '@/lib/auth';

const REQUIRED_SCORE = Number(process.env.NEXT_PUBLIC_REQUIRED_SCORE ?? 7);

export default function RegisterPage() {
  const router = useRouter();

  const [username,  setUsername]  = useState('');
  const [wallet,    setWallet]    = useState('');
  const [error,     setError]     = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);

  useEffect(() => {
    if (isLoggedIn()) router.replace('/verify');
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedWallet = wallet.trim();
    if (!trimmedWallet || !/^0x[0-9a-fA-F]{40}$/.test(trimmedWallet)) {
      setError('Please enter a valid Ethereum wallet address (0x…).');
      return;
    }
    if (!username.trim()) {
      setError('Please choose a username.');
      return;
    }
    if (username.trim().length < 3) {
      setError('Username must be at least 3 characters.');
      return;
    }

    setLoading(true);
    await new Promise((r) => setTimeout(r, 500));
    login(username.trim(), trimmedWallet);
    router.push('/verify');
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">

      <Link href="/" className="absolute top-6 left-6 text-slate-500 hover:text-slate-300 text-sm transition-colors">
        ← Back
      </Link>

      <div className="w-full max-w-md space-y-6 animate-fade-in">

        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="text-emerald-400 font-black text-2xl">FHE</span>
            <span className="text-slate-100 font-black text-2xl">TradeSafe</span>
          </div>
          <h1 className="text-2xl font-black text-slate-100">Create your account</h1>
          <p className="text-slate-500 text-sm">Get started with privacy-first trading</p>
        </div>

        {/* FHE info banner */}
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-violet-500/20 bg-violet-950/20">
          <span className="text-violet-400 text-lg mt-0.5">&#9670;</span>
          <div className="text-sm text-violet-300/80 leading-relaxed space-y-1">
            <p>
              This platform uses{' '}
              <span className="font-bold text-violet-200">Fully Homomorphic Encryption</span>{' '}
              to verify your on-chain trust score.
            </p>
            <p>
              A minimum score of{' '}
              <span className="font-bold text-violet-200">{REQUIRED_SCORE}/10</span>{' '}
              is required to access trading. Your wallet data stays private throughout.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="satoshi"
              className="input-field"
              autoComplete="username"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Wallet Address
            </label>
            <input
              type="text"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
              className="input-field"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <p className="text-[11px] text-slate-600">
              Your Sepolia Ethereum address — used for the privacy-preserving trust score scan
            </p>
          </div>

          {error && (
            <div className="text-sm text-red-400 bg-red-950/30 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Creating account…
              </>
            ) : (
              'Create Account & Verify Score'
            )}
          </button>
        </form>

        <p className="text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link href="/login" className="text-emerald-400 hover:text-emerald-300 font-medium transition-colors">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
