'use client';

const AUTH_KEY   = 'fheguard_td_auth';
const WALLET_KEY = 'fheguard_td_wallet';
const USER_KEY   = 'fheguard_td_user';

/** Check whether the user has completed mock registration/login. */
export function isLoggedIn(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(AUTH_KEY) === 'true';
}

/** Persist a mock login session. */
export function login(username: string, walletAddress: string): void {
  localStorage.setItem(AUTH_KEY,   'true');
  localStorage.setItem(USER_KEY,   username);
  localStorage.setItem(WALLET_KEY, walletAddress);
}

/** Clear the mock session. */
export function logout(): void {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(WALLET_KEY);
  localStorage.removeItem('fheguard_td_scanned');
}

/** Return the stored wallet address, or null. */
export function getWalletAddress(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(WALLET_KEY);
}

/** Return the stored username, or null. */
export function getUsername(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(USER_KEY);
}

/** Mark that a scan has been completed for this session. */
export function markScanned(): void {
  localStorage.setItem('fheguard_td_scanned', 'true');
}

/** Check if a scan has already been completed. */
export function hasBeenScanned(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('fheguard_td_scanned') === 'true';
}
