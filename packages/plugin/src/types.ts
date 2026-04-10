import type { NetworkId } from './lib/networks.js';

export type ScanStatus =
  | 'idle'
  | 'scanning'
  | 'fetching'
  | 'encrypting'
  | 'predicting'
  | 'complete'
  | 'error';

export interface ScanResult {
  label: 'trusted' | 'blocked' | 'insufficient_data';
  encryptedScore: string;
  decision: string;
  computedAt: number;
  rawScore?: number | null;
  rawRisk?: number | null;
}

export interface FheGuardConfig {
  /** Minimum trust score (0–10) to pass the gate. Default: 7 */
  threshold?: number;
  /** Network to scan on. Default: 'sepolia' */
  network?: NetworkId;
  /** API route for the scan SSE endpoint. Default: '/api/scan' */
  scanEndpoint?: string;
}

export interface FheGuardState {
  status: ScanStatus;
  score: number | null;
  result: ScanResult | null;
  isAllowed: boolean;
  isLoading: boolean;
  error: string | null;
}
