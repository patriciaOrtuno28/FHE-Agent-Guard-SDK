'use client';

import React, { createContext, useContext, useState } from 'react';
import type { FheGuardConfig, FheGuardState } from '../types.js';

interface FheGuardContextValue extends FheGuardState {
  config: Required<FheGuardConfig>;
  setScan: (updates: Partial<FheGuardState>) => void;
}

const FheGuardContext = createContext<FheGuardContextValue | null>(null);

export function FheGuardProvider({
  children,
  threshold = 7,
  network = 'sepolia',
  scanEndpoint = '/api/scan',
}: React.PropsWithChildren<FheGuardConfig>) {
  const [state, setState] = useState<FheGuardState>({
    status: 'idle',
    score: null,
    result: null,
    isAllowed: false,
    isLoading: false,
    error: null,
  });

  const setScan = (updates: Partial<FheGuardState>) =>
    setState((prev) => ({ ...prev, ...updates }));

  return (
    <FheGuardContext.Provider
      value={{
        ...state,
        config: { threshold, network, scanEndpoint },
        setScan,
      }}
    >
      {children}
    </FheGuardContext.Provider>
  );
}

export function useFheGuardContext() {
  const ctx = useContext(FheGuardContext);
  if (!ctx) throw new Error('useFheGuardContext must be used inside <FheGuardProvider>');
  return ctx;
}
