'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { useFheGuard, decryptAnomalyScore, isFheSupported } from '@fhe-guard/plugin';
import { isLoggedIn, logout, getUsername, getWalletAddress, removeAccount } from '@/lib/auth';
import { getChainId } from '@/lib/chain';

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_TRUST_SCORE_AGENT_SEPOLIA as `0x${string}` | undefined;

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
  const [username,      setUsername]      = useState('Trader');
  const [wallet,        setWallet]        = useState<string | null>(null);
  const [cachedScore,   setCachedScore]   = useState<number | null>(null);
  const [alreadyVerified, setAlreadyVerified] = useState(false);
  useEffect(() => {
    const w = getWalletAddress();
    setWallet(w);
    void getUsername().then((name) => setUsername(name ?? 'Trader'));
    const prevScore   = localStorage.getItem('fheguard_td_score');
    const prevAllowed = localStorage.getItem('fheguard_td_allowed');
    if (prevScore !== null && prevAllowed === '1') {
      setCachedScore(parseFloat(prevScore));
      setAlreadyVerified(true);
    }
    void getChainId().then(setChainId);
    if (typeof window !== 'undefined') {
      setFheHandle(localStorage.getItem('lastSubmittedFheHandle'));
    }
    // fetch pending invite count
    if (w) {
      void fetch(`/api/trade/invite?wallet=${encodeURIComponent(w)}&type=received`)
        .then((r) => r.json() as Promise<{ invites: { status: string }[] }>)
        .then((d) => setPendingInvites(d.invites.filter((i) => i.status === 'pending').length))
        .catch(() => null);
    }
  }, []);

  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing,      setRemoving]      = useState(false);

  // ── On-chain decrypt ──────────────────────────────────────────────────────
  const [chainId,        setChainId]        = useState<number | null>(null);
  const [fheHandle,      setFheHandle]      = useState<string | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<bigint | null>(null);
  const [decrypting,     setDecrypting]     = useState(false);
  const [decryptError,   setDecryptError]   = useState<string | null>(null);

  // ── Pending invites badge ─────────────────────────────────────────────────
  const [pendingInvites, setPendingInvites] = useState(0);

  const [tradeModal, setTradeModal] = useState<Asset | null>(null);
  const [tradeAmount, setTradeAmount] = useState('');
  const [tradeSide,   setTradeSide]   = useState<'buy' | 'sell'>('buy');
  const [toastMsg,    setToastMsg]    = useState<string | null>(null);

  // Guard: must be logged in and have passed the score check
  useEffect(() => {
    if (!isLoggedIn()) {
      router.replace('/');
      return;
    }
    // Skip re-verification if the user already completed it this session.
    if (alreadyVerified) return;
    if (status === 'idle') router.replace('/verify');
  }, [router, status, alreadyVerified]);

  // If a fresh scan completes and the user is not allowed, redirect
  useEffect(() => {
    if (status === 'complete' && !isAllowed && !alreadyVerified) {
      router.replace('/verify');
    }
  }, [status, isAllowed, router, alreadyVerified]);

  function handleLogout() {
    logout();
    router.push('/');
  }

  async function handleRemoveAccount() {
    setRemoving(true);
    await removeAccount();
    router.push('/');
  }

  async function handleDecryptMyScore() {
    if (!wallet || !chainId || !fheHandle || !CONTRACT_ADDRESS) return;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const value = await decryptAnomalyScore({
        chainId,
        userAddress:     getAddress(wallet) as `0x${string}`,
        contractAddress: getAddress(CONTRACT_ADDRESS) as `0x${string}`,
        handle:          fheHandle as Hex,
      });
      setDecryptedScore(value);
    } catch (err) {
      setDecryptError(err instanceof Error ? err.message : 'Decryption failed');
    } finally {
      setDecrypting(false);
    }
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

  // Show spinner only when there's no cached verification and scan hasn't finished yet
  if (!alreadyVerified && status !== 'complete') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="text-center space-y-3">
          <span className="inline-block w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-500 text-sm">Verifying access…</p>
        </div>
      </div>
    );
  }

  // Use live score when available, fall back to cached value
  const displayScore = score ?? cachedScore;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">

      {/* Navbar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-emerald-400 font-black text-xl">FHE</span>
          <span className="text-slate-100 font-black text-xl">TradeSafe</span>
        </div>

        <div className="flex items-center gap-4">
          {/* Nav links */}
          <nav className="flex items-center gap-3 text-xs">
            <button
              onClick={() => router.push('/directory')}
              className="text-slate-500 hover:text-slate-300 transition-colors"
            >
              Directory
            </button>
            <button
              onClick={() => router.push('/invites')}
              className="relative text-slate-500 hover:text-slate-300 transition-colors"
            >
              Invites
              {pendingInvites > 0 && (
                <span className="absolute -top-1.5 -right-3 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold leading-tight">
                  {pendingInvites}
                </span>
              )}
            </button>
          </nav>

          <span className="text-slate-800">|</span>

          {/* Trust score badge */}
          {displayScore !== null && (
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-950/30 text-xs">
              <span className="text-slate-500">Trust Score</span>
              <span className="font-black text-emerald-300">{displayScore.toFixed(1)}/{threshold}</span>
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

          {!confirmRemove ? (
            <>
              <button
                onClick={handleLogout}
                className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
              >
                Sign out
              </button>
              <button
                onClick={() => setConfirmRemove(true)}
                className="text-xs text-red-800 hover:text-red-500 transition-colors"
              >
                Remove account
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-400">Delete your account?</span>
              <button
                onClick={() => void handleRemoveAccount()}
                disabled={removing}
                className="text-xs px-2 py-0.5 rounded border border-red-600 text-red-400 hover:bg-red-600 hover:text-white transition-all disabled:opacity-50"
              >
                {removing ? 'Removing…' : 'Confirm'}
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
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
              {displayScore !== null ? `${displayScore.toFixed(1)}/10` : '–'}
            </div>
            <div className="text-[11px] text-slate-600">FHE-verified — plaintext never exposed</div>
          </div>
          <div className="card space-y-1">
            <div className="text-xs text-slate-500 uppercase tracking-wide">Access Level</div>
            <div className="text-2xl font-black text-emerald-300">Full Access</div>
            <div className="text-[11px] text-slate-600">Score ≥ required {threshold}/10</div>
          </div>
        </section>

        {/* On-chain score decrypt */}
        {fheHandle && CONTRACT_ADDRESS && chainId !== null && isFheSupported(chainId) && (
          <section className="card space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-widest">On-Chain Score</div>
                <div className="text-[11px] text-slate-600 mt-0.5">Re-decrypt your FHE score from the contract at any time</div>
              </div>
              {decryptedScore !== null && (
                <span className="text-2xl font-black text-emerald-300 font-mono">{decryptedScore.toString()}/10</span>
              )}
            </div>
            {decryptedScore === null && (
              <button
                onClick={() => void handleDecryptMyScore()}
                disabled={decrypting}
                className="w-full py-2 rounded-lg border border-violet-500/40 text-violet-300 text-xs font-semibold
                           hover:bg-violet-500/10 hover:border-violet-400 transition-all
                           disabled:opacity-50 disabled:cursor-wait flex items-center justify-center gap-2"
              >
                {decrypting ? (
                  <><span className="inline-block w-3.5 h-3.5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />Signing &amp; decrypting…</>
                ) : (
                  '🔓 Decrypt My On-Chain Score'
                )}
              </button>
            )}
            {decryptError && <p className="text-[11px] text-red-400">{decryptError}</p>}
          </section>
        )}

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
