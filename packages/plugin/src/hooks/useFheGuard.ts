'use client';

import { useCallback } from 'react';
import { useFheGuardContext } from '../context/FheGuardProvider.js';
import type { ScanResult } from '../types.js';

export function useFheGuard() {
  const { status, score, result, isAllowed, isLoading, error, config, setScan } =
    useFheGuardContext();

  const scan = useCallback(
    async (walletAddress: string) => {
      setScan({ status: 'scanning', isLoading: true, error: null, result: null, score: null, isAllowed: false });
      try {
        const res = await fetch(config.scanEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: walletAddress, network: config.network }),
        });

        if (!res.ok || !res.body) {
          throw new Error(`Scan request failed: HTTP ${res.status}`);
        }

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            let event: Record<string, unknown>;
            try { event = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }

            switch (event.type as string) {
              case 'fetch_done':
                setScan({ status: 'fetching' });
                break;
              case 'encrypt_done':
                setScan({ status: 'encrypting' });
                break;
              case 'predict_done':
                setScan({ status: 'predicting' });
                break;
              case 'scan_complete': {
                const r = event.result as ScanResult;
                const rawScore = r.rawScore ?? null;
                const passed   = rawScore !== null && rawScore >= config.threshold;
                setScan({
                  status:    'complete',
                  result:    r,
                  score:     rawScore,
                  isAllowed: passed,
                  isLoading: false,
                });
                break;
              }
              case 'error':
                setScan({
                  status:    'error',
                  error:     String(event.message ?? 'Unknown scan error'),
                  isLoading: false,
                });
                break;
            }
          }
        }
      } catch (err) {
        setScan({
          status:    'error',
          error:     err instanceof Error ? err.message : 'Unknown error',
          isLoading: false,
        });
      }
    },
    [config, setScan],
  );

  return { scan, status, score, result, isAllowed, isLoading, error, threshold: config.threshold };
}
