'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAddress } from 'viem';
import { encodeFunctionData } from 'viem';
import { isFheSupported, handleToHex32 } from '@fhe-guard/plugin';
import { isLoggedIn, getWalletAddress, getUsername } from '@/lib/auth';
import { FHEVM_ACL_SEPOLIA, ACL_ABI, getChainId, waitForReceipt } from '@/lib/chain';

interface User { wallet: string; username: string }

const ACL_DURATIONS = [
  { label: '1 hour',   ms: 3_600_000 },
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days',   ms: 604_800_000 },
];

export default function DirectoryPage() {
  const router = useRouter();
  const [wallet,   setWallet]   = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [chainId,  setChainId]  = useState<number | null>(null);
  const [users,    setUsers]    = useState<User[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [fheHandle, setFheHandle] = useState<string | null>(null);

  // ── Invite modal state ────────────────────────────────────────────────────
  const [inviteTarget, setInviteTarget] = useState<User | null>(null);
  const [offer,        setOffer]        = useState('');
  const [duration,     setDuration]     = useState(ACL_DURATIONS[1]); // 24h default
  const [grantStep,    setGrantStep]    = useState<'idle' | 'granting' | 'sending' | 'done' | 'error'>('idle');
  const [grantError,   setGrantError]   = useState<string | null>(null);

  useEffect(() => {
    if (!isLoggedIn()) { router.replace('/'); return; }
    const w = getWalletAddress();
    setWallet(w);
    setFheHandle(typeof window !== 'undefined' ? localStorage.getItem('lastFheHandle') : null);
    void getUsername().then((n) => setUsername(n ?? 'Trader'));
    void getChainId().then(setChainId);
  }, [router]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/users');
      const data = await res.json() as { users: User[] };
      setUsers(data.users);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchUsers(); }, [fetchUsers]);

  const onSepoliaWithHandle = chainId !== null && isFheSupported(chainId) && !!fheHandle;

  function openInviteModal(user: User) {
    setInviteTarget(user);
    setOffer('');
    setDuration(ACL_DURATIONS[1]);
    setGrantStep('idle');
    setGrantError(null);
  }

  function closeModal() {
    setInviteTarget(null);
    setGrantStep('idle');
    setGrantError(null);
  }

  async function handleGrantAndSend() {
    if (!inviteTarget || !wallet || !fheHandle || !chainId) return;
    setGrantError(null);

    // ── Step 1: grant ACL on-chain ─────────────────────────────────────────
    setGrantStep('granting');
    try {
      const handle32 = handleToHex32(fheHandle) as `0x${string}`;
      const data = encodeFunctionData({
        abi: ACL_ABI,
        functionName: 'allow',
        args: [handle32, getAddress(inviteTarget.wallet) as `0x${string}`],
      });
      const txHash = await window.ethereum!.request<string>({
        method: 'eth_sendTransaction',
        params: [{ from: wallet, to: FHEVM_ACL_SEPOLIA, data, gas: '0x30D40' }],
      });
      await waitForReceipt(txHash as string);
    } catch (err) {
      setGrantError(err instanceof Error ? err.message : 'ACL grant failed');
      setGrantStep('error');
      return;
    }

    // ── Step 2: store invite in DB ─────────────────────────────────────────
    setGrantStep('sending');
    try {
      const aclExpiryMs = Date.now() + duration.ms;
      const res = await fetch('/api/trade/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: wallet,
          fromUsername: username,
          to: inviteTarget.wallet,
          toUsername: inviteTarget.username,
          offer: offer.trim() || 'Open trade invitation',
          fheHandle,
          aclExpiryMs,
        }),
      });
      if (!res.ok) throw new Error('Failed to store invite');
      setGrantStep('done');
    } catch (err) {
      setGrantError(err instanceof Error ? err.message : 'Failed to send invite');
      setGrantStep('error');
    }
  }

  const otherUsers = users.filter((u) => u.wallet.toLowerCase() !== wallet?.toLowerCase());

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">

      {/* Navbar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-emerald-400 font-black text-xl">FHE</span>
          <span className="text-slate-100 font-black text-xl">TradeSafe</span>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <button onClick={() => router.push('/dashboard')} className="text-slate-500 hover:text-slate-300 transition-colors">Dashboard</button>
          <span className="text-emerald-400 font-semibold">Directory</span>
          <button onClick={() => router.push('/invites')}   className="text-slate-500 hover:text-slate-300 transition-colors">Trade Invites</button>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400 text-xs">{username}</span>
        </nav>
      </header>

      <main className="flex-1 px-6 py-8 max-w-3xl mx-auto w-full space-y-6">
        <div>
          <h1 className="text-2xl font-black text-slate-100">Trader Directory</h1>
          <p className="text-sm text-slate-500 mt-1">
            Select a trader to send a private trade invitation. Your encrypted score will be shared under a timed FHE ACL.
          </p>
        </div>

        {!onSepoliaWithHandle && (
          <div className="px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-950/20 text-sm text-amber-300">
            {!fheHandle
              ? 'Complete the on-chain FHE verification on the Verify page before sending trade invites.'
              : 'Switch MetaMask to Sepolia to enable trade invitations.'}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <span className="inline-block w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : otherUsers.length === 0 ? (
          <div className="card text-center py-12 text-slate-600">
            No other traders registered yet.
          </div>
        ) : (
          <div className="card p-0 overflow-hidden divide-y divide-slate-800/60">
            {otherUsers.map((user) => (
              <div key={user.wallet} className="flex items-center justify-between px-5 py-4 hover:bg-slate-800/20 transition-colors">
                <div>
                  <div className="font-semibold text-slate-200">{user.username}</div>
                  <div className="text-xs text-slate-600 font-mono">
                    {user.wallet.slice(0, 10)}…{user.wallet.slice(-6)}
                  </div>
                </div>
                <button
                  onClick={() => openInviteModal(user)}
                  disabled={!onSepoliaWithHandle}
                  className="text-xs px-3 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-400
                             hover:bg-emerald-500/10 hover:border-emerald-400 transition-all
                             disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Send Trade Invite
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* ── Invite modal ── */}
      {inviteTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="card w-full max-w-md space-y-5 animate-fade-in">

            <div className="flex items-center justify-between">
              <h3 className="font-black text-slate-100 text-lg">Trade Invitation</h3>
              {grantStep !== 'granting' && grantStep !== 'sending' && (
                <button onClick={closeModal} className="text-slate-600 hover:text-slate-400 text-xl leading-none">&#10005;</button>
              )}
            </div>

            {grantStep === 'done' ? (
              <div className="space-y-3 text-center py-4">
                <div className="text-4xl">&#10003;</div>
                <div className="font-bold text-emerald-300">Invite sent!</div>
                <p className="text-sm text-slate-400">
                  ACL granted to <span className="text-slate-200">{inviteTarget.username}</span> for{' '}
                  <span className="text-emerald-300">{duration.label}</span>.
                  They can now decrypt your trust score before deciding.
                </p>
                <button onClick={closeModal} className="btn-primary w-full text-sm">Close</button>
              </div>
            ) : (
              <>
                {/* Recipient */}
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800/30 border border-slate-700/40">
                  <div className="w-8 h-8 rounded-full bg-emerald-900/40 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-sm">
                    {inviteTarget.username[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="font-semibold text-slate-200 text-sm">{inviteTarget.username}</div>
                    <div className="text-[11px] text-slate-600 font-mono">
                      {inviteTarget.wallet.slice(0, 10)}…{inviteTarget.wallet.slice(-6)}
                    </div>
                  </div>
                </div>

                {/* Offer */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Trade offer</label>
                  <input
                    type="text"
                    value={offer}
                    onChange={(e) => setOffer(e.target.value)}
                    placeholder="e.g. Sell NFT #42 for 10 ETH"
                    className="input-field"
                    disabled={grantStep !== 'idle' && grantStep !== 'error'}
                  />
                </div>

                {/* ACL duration */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Score visibility window</label>
                  <div className="flex gap-2">
                    {ACL_DURATIONS.map((d) => (
                      <button
                        key={d.label}
                        onClick={() => setDuration(d)}
                        disabled={grantStep !== 'idle' && grantStep !== 'error'}
                        className={`flex-1 py-1.5 rounded-lg border text-xs font-semibold transition-all
                          ${duration.ms === d.ms
                            ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                            : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    On-chain ACL is granted permanently; the platform enforces this window after which your score will no longer be shown.
                  </p>
                </div>

                {/* Status */}
                {(grantStep === 'granting' || grantStep === 'sending') && (
                  <div className="flex items-center gap-2 text-sm text-fuchsia-400">
                    <span className="inline-block w-3.5 h-3.5 border-2 border-fuchsia-400 border-t-transparent rounded-full animate-spin" />
                    {grantStep === 'granting' ? 'Granting ACL on-chain via MetaMask…' : 'Storing invitation…'}
                  </div>
                )}
                {grantStep === 'error' && (
                  <p className="text-xs text-red-400">{grantError}</p>
                )}

                <button
                  onClick={() => void handleGrantAndSend()}
                  disabled={grantStep === 'granting' || grantStep === 'sending' || !offer.trim()}
                  className="btn-primary w-full text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-wait"
                >
                  Grant ACL &amp; Send Invite
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
