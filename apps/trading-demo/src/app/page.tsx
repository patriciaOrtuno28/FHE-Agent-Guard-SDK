'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getAddress } from 'viem';
import {
  isLoggedIn, hasAccount, getUsernameForWallet,
  loginWithWallet, register,
} from '@/lib/auth';

declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
      on(event: string, handler: (...args: unknown[]) => void): void;
      removeListener(event: string, handler: (...args: unknown[]) => void): void;
    };
  }
}

const REQUIRED_SCORE = Number(process.env.NEXT_PUBLIC_REQUIRED_SCORE ?? 7);

type Stage =
  | 'idle'          // nothing connected yet
  | 'connecting'    // waiting for MetaMask
  | 'new_user'      // wallet connected, no account — ask for username
  | 'returning'     // wallet connected, account found — auto-proceed
  | 'submitting';   // creating account

export default function LandingPage() {
  const router = useRouter();

  const [stage,    setStage]    = useState<Stage>('idle');
  const [wallet,   setWallet]   = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [error,    setError]    = useState<string | null>(null);

  // If already logged in, skip straight to verification
  useEffect(() => {
    if (isLoggedIn()) router.replace('/verify');
  }, [router]);

  // Listen for MetaMask account changes
  useEffect(() => {
    if (!window.ethereum) return;
    const onAccountsChanged = (raw: unknown) => {
      const accounts = raw as string[];
      if (!accounts[0]) { setWallet(null); setStage('idle'); }
    };
    window.ethereum.on('accountsChanged', onAccountsChanged);
    return () => window.ethereum?.removeListener('accountsChanged', onAccountsChanged);
  }, []);

  async function handleConnectWallet() {
    setError(null);
    if (!window.ethereum) {
      setError('MetaMask not detected. Please install the MetaMask extension.');
      return;
    }
    setStage('connecting');
    try {
      // wallet_requestPermissions forces the account picker every time
      await window.ethereum.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
      const accounts = await window.ethereum.request<string[]>({ method: 'eth_accounts' });
      if (!accounts[0]) { setStage('idle'); return; }

      const addr = getAddress(accounts[0]);
      setWallet(addr);

      if (await hasAccount(addr)) {
        // Returning user — fetch username, log in and proceed
        const name = await getUsernameForWallet(addr);
        loginWithWallet(addr);
        setUsername(name ?? '');
        setStage('returning');
        setTimeout(() => router.push('/verify'), 900);
      } else {
        // New user — ask for a username
        setStage('new_user');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection rejected';
      setError(msg.toLowerCase().includes('reject') ? 'Connection rejected.' : msg);
      setStage('idle');
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!username.trim() || username.trim().length < 3) {
      setError('Username must be at least 3 characters.');
      return;
    }
    if (!wallet) return;
    setStage('submitting');
    await new Promise((r) => setTimeout(r, 300));
    await register(username.trim(), wallet);
    router.push('/verify');
  }

  const shortWallet = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : null;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">

      {/* Minimal nav — no auth buttons */}
      <header className="flex items-center px-8 py-4 border-b border-slate-800/60">
        <div className="flex items-center gap-2">
          <span className="text-emerald-400 font-black text-xl tracking-tight">FHE</span>
          <span className="text-slate-100 font-black text-xl tracking-tight">TradeSafe</span>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16 text-center">
        <div className="max-w-xl mx-auto space-y-8 animate-fade-in">

          {/* Threshold badge */}
          <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-emerald-500/30 bg-emerald-950/40 text-emerald-300 text-sm font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            Platform requires a minimum trust score of
            <span className="font-black text-emerald-200 text-base">{REQUIRED_SCORE}/10</span>
          </div>

          <h1 className="text-5xl font-black tracking-tight text-slate-100 leading-tight">
            Trade with confidence.<br />
            <span className="text-emerald-400">Your privacy is encrypted.</span>
          </h1>

          <p className="text-lg text-slate-400 leading-relaxed">
            FHE TradeSafe evaluates your on-chain trust score using Fully Homomorphic Encryption.
            Your wallet data is never exposed — the analysis runs on encrypted data.
          </p>

          {/* ── Auth widget ── */}
          <div className="max-w-sm mx-auto w-full space-y-3">

            {stage === 'idle' && (
              <>
                <button
                  onClick={handleConnectWallet}
                  className="btn-primary w-full text-base py-3 flex items-center justify-center gap-2"
                >
                  <MetaMaskIcon />
                  Connect Wallet to Enter
                </button>
                {error && <p className="text-sm text-red-400">{error}</p>}
              </>
            )}

            {stage === 'connecting' && (
              <button disabled className="btn-primary w-full text-base py-3 flex items-center justify-center gap-2 opacity-70 cursor-wait">
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Connecting…
              </button>
            )}

            {stage === 'returning' && wallet && (
              <div className="card text-center space-y-2 animate-fade-in">
                <div className="flex items-center justify-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-sm font-mono text-emerald-300">{shortWallet}</span>
                </div>
                <p className="text-slate-300 font-semibold">
                  Welcome back, {username}
                </p>
                <p className="text-sm text-slate-500">Redirecting to trust score verification…</p>
              </div>
            )}

            {(stage === 'new_user' || stage === 'submitting') && wallet && (
              <form onSubmit={handleRegister} className="card space-y-4 text-left animate-fade-in">
                <div className="flex items-center gap-2 pb-1 border-b border-slate-800/60">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                  <span className="text-xs font-mono text-emerald-300">{shortWallet}</span>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                    Choose a username
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="satoshi"
                    className="input-field"
                    autoComplete="off"
                    autoFocus
                    required
                  />
                </div>
                {error && <p className="text-sm text-red-400">{error}</p>}
                <button
                  type="submit"
                  disabled={stage === 'submitting'}
                  className="btn-primary w-full flex items-center justify-center gap-2"
                >
                  {stage === 'submitting' ? (
                    <>
                      <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Creating account…
                    </>
                  ) : (
                    'Create Account & Verify Score'
                  )}
                </button>
              </form>
            )}
          </div>

        </div>
      </main>

      {/* How it works */}
      <section className="border-t border-slate-800/60 bg-slate-900/30 px-6 py-12">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-lg font-black text-center text-slate-300 mb-8 uppercase tracking-widest text-sm">
            How access control works
          </h2>
          <div className="grid grid-cols-4 gap-4">
            {[
              { step: '01', title: 'Connect Wallet', desc: 'Connect MetaMask to identify your Ethereum address' },
              { step: '02', title: 'FHE Scan',       desc: 'On-chain activity analysed under FHE — no plaintext leaves your browser' },
              { step: '03', title: 'Trust Score',    desc: `Score (0–10) compared against the required threshold of ${REQUIRED_SCORE}` },
              { step: '04', title: 'Access',         desc: `Score ≥ ${REQUIRED_SCORE} → full dashboard. Score < ${REQUIRED_SCORE} → access denied` },
            ].map(({ step, title, desc }) => (
              <div key={step} className="card text-center space-y-2 p-4">
                <span className="text-emerald-400 font-black text-xl font-mono">{step}</span>
                <h3 className="font-bold text-slate-200 text-sm">{title}</h3>
                <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-800/60 px-8 py-4 flex items-center justify-between text-xs text-slate-700">
        <span>FHE TradeSafe — Powered by <span className="text-slate-600">@fhe-guard/plugin</span></span>
        <span>Built with Zama FHE</span>
      </footer>
    </div>
  );
}

function MetaMaskIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 318.6 318.6" xmlns="http://www.w3.org/2000/svg">
      <polygon fill="#E2761B" stroke="#E2761B" strokeLinecap="round" strokeLinejoin="round" points="274.1,35.5 174.6,109.4 193,65.8"/>
      <polygon fill="#E4761B" stroke="#E4761B" strokeLinecap="round" strokeLinejoin="round" points="44.4,35.5 143.1,110.1 125.6,65.8"/>
      <polygon fill="#E4761B" stroke="#E4761B" strokeLinecap="round" strokeLinejoin="round" points="238.3,206.8 211.8,247.4 268.5,263 284.8,207.7"/>
      <polygon fill="#E4761B" stroke="#E4761B" strokeLinecap="round" strokeLinejoin="round" points="33.9,207.7 50.1,263 106.8,247.4 80.3,206.8"/>
      <polygon fill="#E4761B" stroke="#E4761B" strokeLinecap="round" strokeLinejoin="round" points="103.6,138.2 87.8,162.1 144.1,164.6 142.1,104.1"/>
      <polygon fill="#E4761B" stroke="#E4761B" strokeLinecap="round" strokeLinejoin="round" points="214.9,138.2 175.9,103.4 174.6,164.6 230.8,162.1"/>
      <polygon fill="#E4761B" stroke="#E4761B" strokeLinecap="round" strokeLinejoin="round" points="106.8,247.4 140.6,230.9 111.4,208.1"/>
      <polygon fill="#E4761B" stroke="#E4761B" strokeLinecap="round" strokeLinejoin="round" points="177.9,230.9 211.8,247.4 207.1,208.1"/>
      <polygon fill="#D7C1B3" stroke="#D7C1B3" strokeLinecap="round" strokeLinejoin="round" points="211.8,247.4 177.9,230.9 180.6,253 180.3,262.3"/>
      <polygon fill="#D7C1B3" stroke="#D7C1B3" strokeLinecap="round" strokeLinejoin="round" points="106.8,247.4 138.3,262.3 138.1,253 140.6,230.9"/>
      <polygon fill="#233447" stroke="#233447" strokeLinecap="round" strokeLinejoin="round" points="138.8,193.5 110.6,185.2 130.5,176.1"/>
      <polygon fill="#233447" stroke="#233447" strokeLinecap="round" strokeLinejoin="round" points="179.7,193.5 188,176.1 208,185.2"/>
      <polygon fill="#CC6228" stroke="#CC6228" strokeLinecap="round" strokeLinejoin="round" points="106.8,247.4 111.6,206.8 80.3,207.7"/>
      <polygon fill="#CC6228" stroke="#CC6228" strokeLinecap="round" strokeLinejoin="round" points="207,206.8 211.8,247.4 238.3,207.7"/>
      <polygon fill="#CC6228" stroke="#CC6228" strokeLinecap="round" strokeLinejoin="round" points="230.8,162.1 174.6,164.6 179.8,193.5 188.1,176.1 208.1,185.2"/>
      <polygon fill="#CC6228" stroke="#CC6228" strokeLinecap="round" strokeLinejoin="round" points="110.6,185.2 130.6,176.1 138.8,193.5 144.1,164.6 87.8,162.1"/>
      <polygon fill="#E27525" stroke="#E27525" strokeLinecap="round" strokeLinejoin="round" points="87.8,162.1 111.4,208.1 110.6,185.2"/>
      <polygon fill="#E27525" stroke="#E27525" strokeLinecap="round" strokeLinejoin="round" points="208.1,185.2 207.1,208.1 230.8,162.1"/>
      <polygon fill="#E27525" stroke="#E27525" strokeLinecap="round" strokeLinejoin="round" points="144.1,164.6 138.8,193.5 145.4,227.6 146.9,182.7"/>
      <polygon fill="#E27525" stroke="#E27525" strokeLinecap="round" strokeLinejoin="round" points="174.6,164.6 171.9,182.6 173.1,227.6 179.8,193.5"/>
      <polygon fill="#F5841F" stroke="#F5841F" strokeLinecap="round" strokeLinejoin="round" points="179.8,193.5 173.1,227.6 177.9,230.9 207.1,208.1 208.1,185.2"/>
      <polygon fill="#F5841F" stroke="#F5841F" strokeLinecap="round" strokeLinejoin="round" points="110.6,185.2 111.4,208.1 140.6,230.9 145.4,227.6 138.8,193.5"/>
      <polygon fill="#C0AD9E" stroke="#C0AD9E" strokeLinecap="round" strokeLinejoin="round" points="180.3,262.3 180.6,253 178.1,250.8 140.4,250.8 138.1,253 138.3,262.3 106.8,247.4 117.8,256.4 140.1,271.9 178.4,271.9 200.8,256.4 211.8,247.4"/>
      <polygon fill="#161616" stroke="#161616" strokeLinecap="round" strokeLinejoin="round" points="177.9,230.9 173.1,227.6 145.4,227.6 140.6,230.9 138.1,253 140.4,250.8 178.1,250.8 180.6,253"/>
      <polygon fill="#763D16" stroke="#763D16" strokeLinecap="round" strokeLinejoin="round" points="278.3,114.2 286.8,73.4 274.1,35.5 177.9,106.9 214.9,138.2 267.2,153.5 278.8,140 273.8,136.4 281.8,129.1 275.6,124.3 283.6,118.2"/>
      <polygon fill="#763D16" stroke="#763D16" strokeLinecap="round" strokeLinejoin="round" points="31.8,73.4 40.3,114.2 34.9,118.2 42.9,124.3 36.8,129.1 44.8,136.4 39.8,140 51.3,153.5 103.6,138.2 140.6,106.9 44.4,35.5"/>
      <polygon fill="#F5841F" stroke="#F5841F" strokeLinecap="round" strokeLinejoin="round" points="267.2,153.5 214.9,138.2 230.8,162.1 207.1,208.1 238.3,207.7 284.8,207.7"/>
      <polygon fill="#F5841F" stroke="#F5841F" strokeLinecap="round" strokeLinejoin="round" points="103.6,138.2 51.3,153.5 33.9,207.7 80.3,207.7 111.4,208.1 87.8,162.1"/>
      <polygon fill="#F5841F" stroke="#F5841F" strokeLinecap="round" strokeLinejoin="round" points="174.6,164.6 177.9,106.9 193.1,65.8 125.6,65.8 140.6,106.9 144.1,164.6 145.3,182.8 145.4,227.6 173.1,227.6 173.2,182.8"/>
    </svg>
  );
}
