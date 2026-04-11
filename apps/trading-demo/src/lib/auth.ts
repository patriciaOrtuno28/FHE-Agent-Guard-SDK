'use client';

// Active session: the wallet address currently logged in (browser-only)
const SESSION_KEY = 'fheguard_td_session';

// ── Session helpers (synchronous, localStorage) ───────────────────────────────

/** Return the active wallet address, or null. */
export function getWalletAddress(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(SESSION_KEY);
}

/** True if there is an active session. */
export function isLoggedIn(): boolean {
  if (typeof window === 'undefined') return false;
  return !!localStorage.getItem(SESSION_KEY);
}

/** Start a session for a wallet (no DB write). */
export function loginWithWallet(wallet: string): void {
  localStorage.setItem(SESSION_KEY, wallet);
}

/** Clear the active session (keeps the account in DB). */
export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('fheguard_td_scanned');
  localStorage.removeItem('lastSubmittedFheHandle');
  localStorage.removeItem('fheguard_td_score');
  localStorage.removeItem('fheguard_td_allowed');
}

/** Mark that a scan has been completed this session. */
export function markScanned(): void {
  localStorage.setItem('fheguard_td_scanned', 'true');
}

// ── Account helpers (async, hit the server DB) ────────────────────────────────

/** Return the username registered for this wallet, or null. */
export async function getUsernameForWallet(wallet: string): Promise<string | null> {
  const res = await fetch(`/api/auth/user?wallet=${encodeURIComponent(wallet)}`);
  const data = await res.json() as { username: string | null };
  return data.username;
}

/** True if this wallet address has a registered account. */
export async function hasAccount(wallet: string): Promise<boolean> {
  return (await getUsernameForWallet(wallet)) !== null;
}

/** Return the username for the active session, or null. */
export async function getUsername(): Promise<string | null> {
  const wallet = getWalletAddress();
  return wallet ? getUsernameForWallet(wallet) : null;
}

/** Register a new account in the DB and start a local session. */
export async function register(username: string, wallet: string): Promise<void> {
  await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, username }),
  });
  localStorage.setItem(SESSION_KEY, wallet);
}

/** Delete account from DB, clear local session and all scan state. */
export async function removeAccount(): Promise<void> {
  const wallet = getWalletAddress();
  if (!wallet) return;
  await fetch('/api/auth/user', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet }),
  });
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('fheguard_td_scanned');
  localStorage.removeItem('lastFheHandle');
  localStorage.removeItem('lastSubmittedFheHandle');
  localStorage.removeItem('fheguard_td_score');
  localStorage.removeItem('fheguard_td_allowed');
}
