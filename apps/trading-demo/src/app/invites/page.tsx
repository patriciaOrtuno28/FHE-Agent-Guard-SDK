'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAddress } from 'viem';
import type { Hex } from 'viem';
import { decryptAnomalyScore, isFheSupported } from '@fhe-guard/plugin';
import { isLoggedIn, getWalletAddress, getUsername } from '@/lib/auth';
import { getChainId } from '@/lib/chain';
import type { TradeInvite } from '@/app/api/trade/invite/route';

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_TRUST_SCORE_AGENT_SEPOLIA as `0x${string}` | undefined;

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeRemaining(expiryMs: number): string {
  const ms = expiryMs - Date.now();
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h remaining`;
  if (h > 0)   return `${h}h ${m}m remaining`;
  return `${m}m remaining`;
}

function isExpired(expiryMs: number): boolean { return expiryMs < Date.now(); }

// ── Per-invite card ───────────────────────────────────────────────────────────

function InviteCard({
  invite,
  myWallet,
  chainId,
  onStatusChange,
}: {
  invite: TradeInvite;
  myWallet: string;
  chainId: number | null;
  onStatusChange: (id: string, status: TradeInvite['status']) => void;
}) {
  const [decryptedScore, setDecryptedScore]   = useState<bigint | null>(null);
  const [decrypting,     setDecrypting]       = useState(false);
  const [decryptError,   setDecryptError]     = useState<string | null>(null);
  const [acting,         setActing]           = useState(false);

  const canDecrypt =
    !isExpired(invite.aclExpiryMs) &&
    chainId !== null &&
    isFheSupported(chainId) &&
    !!CONTRACT_ADDRESS &&
    invite.status !== 'accepted' &&
    invite.status !== 'declined';

  async function handleDecrypt() {
    if (!chainId || !CONTRACT_ADDRESS) return;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const value = await decryptAnomalyScore({
        chainId,
        userAddress:     getAddress(myWallet) as `0x${string}`,
        contractAddress: getAddress(CONTRACT_ADDRESS) as `0x${string}`,
        handle:          invite.fheHandle as Hex,
      });
      setDecryptedScore(value);
      if (invite.status === 'pending') {
        await updateStatus('score_seen');
      }
    } catch (err) {
      setDecryptError(err instanceof Error ? err.message : 'Decryption failed');
    } finally {
      setDecrypting(false);
    }
  }

  async function updateStatus(status: TradeInvite['status']) {
    setActing(true);
    try {
      await fetch(`/api/trade/invite/${invite.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      onStatusChange(invite.id, status);
    } finally {
      setActing(false);
    }
  }

  const statusBadge: Record<TradeInvite['status'], string> = {
    pending:    'bg-slate-700/50 text-slate-400',
    score_seen: 'bg-violet-900/40 text-violet-300',
    accepted:   'bg-emerald-900/40 text-emerald-300',
    declined:   'bg-red-900/30 text-red-400',
  };

  const statusLabel: Record<TradeInvite['status'], string> = {
    pending:    'Pending',
    score_seen: 'Score viewed',
    accepted:   'Accepted',
    declined:   'Declined',
  };

  return (
    <div className="card space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-violet-900/40 border border-violet-500/30 flex items-center justify-center text-violet-400 font-bold">
            {invite.fromUsername[0].toUpperCase()}
          </div>
          <div>
            <div className="font-semibold text-slate-200">{invite.fromUsername}</div>
            <div className="text-[11px] text-slate-600 font-mono">
              {invite.from.slice(0, 10)}…{invite.from.slice(-6)}
            </div>
          </div>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${statusBadge[invite.status]}`}>
          {statusLabel[invite.status]}
        </span>
      </div>

      {/* Offer */}
      <div className="px-3 py-2 rounded-lg bg-slate-800/30 border border-slate-700/40">
        <div className="text-[10px] text-slate-600 uppercase tracking-wide mb-0.5">Trade offer</div>
        <div className="text-sm text-slate-200">{invite.offer}</div>
      </div>

      {/* ACL window */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-600">Score access window</span>
        <span className={isExpired(invite.aclExpiryMs) ? 'text-red-400' : 'text-emerald-400'}>
          {timeRemaining(invite.aclExpiryMs)}
        </span>
      </div>

      {/* Decrypt */}
      {invite.status !== 'accepted' && invite.status !== 'declined' && (
        <div className="space-y-2 border-t border-slate-800/60 pt-3">
          {decryptedScore !== null ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-slate-500 uppercase tracking-wide">Trust Score (KMS decrypted)</div>
                <div className="text-[11px] text-slate-600">Verified via Zama KMS — data was never plaintext</div>
              </div>
              <span className="text-2xl font-black text-emerald-300 font-mono ml-4">{decryptedScore.toString()}/10</span>
            </div>
          ) : (
            <>
              <button
                onClick={() => void handleDecrypt()}
                disabled={decrypting || !canDecrypt}
                className="w-full py-2 rounded-lg border border-violet-500/40 text-violet-300 text-xs font-semibold
                           hover:bg-violet-500/10 hover:border-violet-400 transition-all
                           disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {decrypting ? (
                  <><span className="inline-block w-3.5 h-3.5 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />Decrypting…</>
                ) : isExpired(invite.aclExpiryMs) ? (
                  'Access window expired'
                ) : !canDecrypt ? (
                  'Switch to Sepolia to decrypt'
                ) : (
                  '🔓 Decrypt Trust Score'
                )}
              </button>
              {decryptError && <p className="text-[11px] text-red-400">{decryptError}</p>}
            </>
          )}

          {/* Accept / Decline */}
          {(decryptedScore !== null || invite.status === 'score_seen') && (
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => void updateStatus('accepted')}
                disabled={acting}
                className="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all disabled:opacity-50"
              >
                Accept trade
              </button>
              <button
                onClick={() => void updateStatus('declined')}
                disabled={acting}
                className="flex-1 py-2 rounded-lg border border-red-600 text-red-400 hover:bg-red-600 hover:text-white text-xs font-bold transition-all disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          )}
        </div>
      )}

      {/* Final state */}
      {(invite.status === 'accepted' || invite.status === 'declined') && (
        <div className={`text-center text-sm font-bold py-2 rounded-lg ${
          invite.status === 'accepted' ? 'text-emerald-300 bg-emerald-950/30' : 'text-red-400 bg-red-950/20'
        }`}>
          {invite.status === 'accepted' ? '&#10003; Trade accepted' : '&#10007; Trade declined'}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InvitesPage() {
  const router = useRouter();
  const [wallet,          setWallet]          = useState<string | null>(null);
  const [username,        setUsername]        = useState('');
  const [chainId,         setChainId]         = useState<number | null>(null);
  const [receivedInvites, setReceivedInvites] = useState<TradeInvite[]>([]);
  const [sentInvites,     setSentInvites]     = useState<TradeInvite[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [tab,             setTab]             = useState<'received' | 'sent'>('received');

  const fetchBoth = useCallback(async (w: string) => {
    setLoading(true);
    try {
      const [recRes, sentRes] = await Promise.all([
        fetch(`/api/trade/invite?wallet=${encodeURIComponent(w)}&type=received`),
        fetch(`/api/trade/invite?wallet=${encodeURIComponent(w)}&type=sent`),
      ]);
      const [recData, sentData] = await Promise.all([
        recRes.json()  as Promise<{ invites: TradeInvite[] }>,
        sentRes.json() as Promise<{ invites: TradeInvite[] }>,
      ]);
      setReceivedInvites(recData.invites);
      setSentInvites(sentData.invites);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn()) { router.replace('/'); return; }
    const w = getWalletAddress();
    setWallet(w);
    void getUsername().then((n) => setUsername(n ?? 'Trader'));
    void getChainId().then(setChainId);
    if (w) void fetchBoth(w);
  }, [router, fetchBoth]);

  function handleStatusChange(id: string, status: TradeInvite['status']) {
    setReceivedInvites((prev) => prev.map((inv) => inv.id === id ? { ...inv, status } : inv));
  }

  const invites = tab === 'received' ? receivedInvites : sentInvites;
  // Badge counts only truly received pending invites, regardless of active tab.
  const receivedPendingCount = receivedInvites.filter((i) => i.status === 'pending').length;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">

      {/* Navbar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-emerald-400 font-black text-xl">FHE</span>
          <span className="text-slate-100 font-black text-xl">TradeSafe</span>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <button onClick={() => router.push('/dashboard')}  className="text-slate-500 hover:text-slate-300 transition-colors">Dashboard</button>
          <button onClick={() => router.push('/directory')}  className="text-slate-500 hover:text-slate-300 transition-colors">Directory</button>
          <span className="text-emerald-400 font-semibold">Trade Invites</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400 text-xs">{username}</span>
        </nav>
      </header>

      <main className="flex-1 px-6 py-8 max-w-2xl mx-auto w-full space-y-6">
        <div>
          <h1 className="text-2xl font-black text-slate-100">Trade Invitations</h1>
          <p className="text-sm text-slate-500 mt-1">
            Decrypt a sender&apos;s trust score using their FHE ACL grant, then accept or decline.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex rounded-lg overflow-hidden border border-slate-700/60 w-fit">
          {(['received', 'sent'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2 text-sm font-semibold capitalize transition-colors ${
                tab === t
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t}
              {t === 'received' && receivedPendingCount > 0 && (
                <span className="ml-2 px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold">
                  {receivedPendingCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <span className="inline-block w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : invites.length === 0 ? (
          <div className="card text-center py-12 text-slate-600">
            No {tab} invitations yet.
          </div>
        ) : (
          <div className="space-y-4">
            {invites.map((invite) =>
              tab === 'received' ? (
                <InviteCard
                  key={invite.id}
                  invite={invite}
                  myWallet={wallet ?? ''}
                  chainId={chainId}
                  onStatusChange={handleStatusChange}
                />
              ) : (
                // Sent invite summary
                <div key={invite.id} className="card space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-slate-200">{invite.toUsername}</div>
                      <div className="text-[11px] text-slate-600 font-mono">
                        {invite.to.slice(0, 10)}…{invite.to.slice(-6)}
                      </div>
                    </div>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${
                      invite.status === 'accepted' ? 'bg-emerald-900/40 text-emerald-300' :
                      invite.status === 'declined' ? 'bg-red-900/30 text-red-400' :
                      'bg-slate-700/50 text-slate-400'
                    }`}>
                      {invite.status === 'pending' ? 'Awaiting response' :
                       invite.status === 'score_seen' ? 'Score viewed' :
                       invite.status === 'accepted' ? 'Accepted' : 'Declined'}
                    </span>
                  </div>
                  <div className="text-sm text-slate-400">{invite.offer}</div>
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span>Access window</span>
                    <span className={isExpired(invite.aclExpiryMs) ? 'text-red-400' : 'text-emerald-400'}>
                      {timeRemaining(invite.aclExpiryMs)}
                    </span>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </main>
    </div>
  );
}
