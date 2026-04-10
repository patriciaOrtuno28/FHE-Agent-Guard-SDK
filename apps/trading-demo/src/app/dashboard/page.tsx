'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFheGuard } from '@fhe-guard/plugin';
import { isLoggedIn, logout, getUsername, getWalletAddress } from '@/lib/auth';

// ── Mock market data ──────────────────────────────────────────────────────────

interface Asset {
  symbol:  string;
  name:    string;
  price:   number;
  change:  number;
  balance: number;
}

const MOCK_ASSETS: Asset[] = [
  { symbol: 'ETH',  name: 'Ethereum',       price: 3412.50, change:  2.34, balance: 1.42 },
  { symbol: 'BTC',  name: 'Bitcoin',         price: 67820.00, change: -0.87, balance: 0.05 },
  { symbol: 'USDC', name: 'USD Coin',        price: 1.00,    change:  0.01, balance: 2500.00 },
  { symbol: 'ARB',  name: 'Arbitrum',        price: 1.23,    change:  5.12, balance: 400.00 },
  { symbol: 'LINK', name: 'Chainlink',       price: 14.67,   change:  1.43, balance: 50.00 },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router  = useRouter();
  const { score, isAllowed, status, threshold } = useFheGuard();
  const username = getUsername() ?? 'Trader';
  const wallet   = getWalletAddress();

  const [tradeModal, setTradeModal] = useState<Asset | null>(null);
  const [tradeAmount, setTradeAmount] = useState('');
  const [tradeSide,   setTradeSide]   = useState<'buy' | 'sell'>('buy');
  const [toastMsg,    setToastMsg]    = useState<string | null>(null);

  // Guard: must be logged in and have passed the score check
  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace('/login');
      return;
    }
    // If we arrive here without a completed scan, re-verify
    if (status === 'idle') {
      router.replace('/verify');
    }
  }, [router, status]);

  // If scan completes and user is not allowed, redirect
  useEffect(() => {
    if (status === 'complete' && !isAllowed) {
      router.replace('/verify');
    }
  }, [status, isAllowed, router]);

  function handleLogout() {
    logout();
    router.push('/');
  }

  function handleTrade(asset: Asset) {
    setTradeModal(asset);
    setTradeAmount('');
    setTradeSide('buy');
  }

  function handleConfirmTrade() {
    if (!tradeModal || !tradeAmount) return;
    setToastMsg(`${tradeSide === 'buy' ? 'Bought' : 'Sold'} ${tradeAmount} ${tradeModal.symbol} — order simulated`);
    setTradeModal(null);
    setTimeout(() => setToastMsg(null), 3000);
  }

  const totalPortfolioValue = MOCK_ASSETS.reduce(
    (sum, a) => sum + a.price * a.balance, 0,
  );

  if (status === 'idle' || (status !== 'complete')) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="text-center space-y-3">
          <span className="inline-block w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-500 text-sm">Verifying access…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">

      {/* Navbar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-emerald-400 font-black text-xl">FHE</span>
          <span className="text-slate-100 font-black text-xl">TradeSafe</span>
        </div>

        <div className="flex items-center gap-4">
          {/* Trust score badge */}
          {score !== null && (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-950/30 text-xs">
              <span className="text-slate-500">Trust Score</span>
              <span className="font-black text-emerald-300">{score.toFixed(1)}/{threshold}</span>
            </div>
          )}

          <div className="text-sm text-slate-400">
            {username}
            {wallet && (
              <span className="ml-2 text-xs text-slate-600 font-mono">
                {wallet.slice(0, 6)}…{wallet.slice(-4)}
              </span>
            )}
          </div>

          <button
            onClick={handleLogout}
            className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 px-6 py-8 max-w-5xl mx-auto w-full space-y-8">

        {/* Portfolio summary */}
        <section className="grid grid-cols-3 gap-4">
          <div className="card space-y-1">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Portfolio Value</div>
            <div className="text-2xl font-black text-slate-100">
              ${totalPortfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className="card space-y-1">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Trust Score</div>
            <div className="text-2xl font-black text-emerald-300">
              {score !== null ? `${score.toFixed(1)}/10` : '–'}
            </div>
            <div className="text-[11px] text-slate-600">FHE-verified — plaintext never exposed</div>
          </div>
          <div className="card space-y-1">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Access Level</div>
            <div className="text-2xl font-black text-emerald-300">Full Access</div>
            <div className="text-[11px] text-slate-600">Score ≥ required {threshold}/10</div>
          </div>
        </section>

        {/* Markets */}
        <section>
          <h2 className="text-lg font-black text-slate-100 mb-4">Your Assets</h2>
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800/80 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="text-left px-5 py-3 font-semibold">Asset</th>
                  <th className="text-right px-5 py-3 font-semibold">Price</th>
                  <th className="text-right px-5 py-3 font-semibold">24h</th>
                  <th className="text-right px-5 py-3 font-semibold">Balance</th>
                  <th className="text-right px-5 py-3 font-semibold">Value</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {MOCK_ASSETS.map((asset, i) => (
                  <tr
                    key={asset.symbol}
                    className={`border-b border-slate-800/40 hover:bg-slate-800/30 transition-colors ${
                      i === MOCK_ASSETS.length - 1 ? 'border-b-0' : ''
                    }`}
                  >
                    <td className="px-5 py-3.5">
                      <div className="font-bold text-slate-100">{asset.symbol}</div>
                      <div className="text-xs text-slate-500">{asset.name}</div>
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono text-slate-300">
                      ${asset.price.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </td>
                    <td className={`px-5 py-3.5 text-right font-mono font-semibold ${
                      asset.change >= 0 ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {asset.change >= 0 ? '+' : ''}{asset.change.toFixed(2)}%
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono text-slate-400">
                      {asset.balance.toLocaleString()} {asset.symbol}
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono text-slate-300">
                      ${(asset.price * asset.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={() => handleTrade(asset)}
                        className="text-xs px-3 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-400
                                   hover:bg-emerald-500/10 hover:border-emerald-400 transition-all"
                      >
                        Trade
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

      </main>

      {/* Trade modal */}
      {tradeModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="card w-full max-w-sm space-y-4 animate-fade-in">
            <div className="flex items-center justify-between">
              <h3 className="font-black text-slate-100 text-lg">Trade {tradeModal.symbol}</h3>
              <button
                onClick={() => setTradeModal(null)}
                className="text-slate-600 hover:text-slate-400 text-xl leading-none"
              >
                &#10005;
              </button>
            </div>

            <div className="flex rounded-lg overflow-hidden border border-slate-700">
              {(['buy', 'sell'] as const).map((side) => (
                <button
                  key={side}
                  onClick={() => setTradeSide(side)}
                  className={`flex-1 py-2 text-sm font-bold capitalize transition-colors ${
                    tradeSide === side
                      ? side === 'buy'
                        ? 'bg-emerald-600 text-white'
                        : 'bg-red-600 text-white'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {side}
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-500 uppercase tracking-wide">
                Amount ({tradeModal.symbol})
              </label>
              <input
                type="number"
                value={tradeAmount}
                onChange={(e) => setTradeAmount(e.target.value)}
                placeholder="0.00"
                className="input-field"
                min="0"
                step="0.01"
              />
              <p className="text-xs text-slate-600">
                Price: ${tradeModal.price.toLocaleString()} per {tradeModal.symbol}
              </p>
            </div>

            {tradeAmount && Number(tradeAmount) > 0 && (
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-800/40 text-sm">
                <span className="text-slate-500">Total</span>
                <span className="font-bold text-slate-200">
                  ${(tradeModal.price * Number(tradeAmount)).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>
            )}

            <p className="text-[11px] text-slate-600">
              This is a demo — no real transactions will be executed.
            </p>

            <button
              onClick={handleConfirmTrade}
              disabled={!tradeAmount || Number(tradeAmount) <= 0}
              className={`w-full py-2.5 rounded-lg font-bold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                tradeSide === 'buy'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-red-600 hover:bg-red-500 text-white'
              }`}
            >
              Confirm {tradeSide === 'buy' ? 'Buy' : 'Sell'}
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-3 rounded-xl bg-slate-800 border border-slate-700 text-sm text-slate-200 shadow-xl animate-fade-in z-50">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
