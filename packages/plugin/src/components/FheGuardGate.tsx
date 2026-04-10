'use client';

import React from 'react';
import { useFheGuardContext } from '../context/FheGuardProvider.js';

interface FheGuardGateProps {
  /** Content shown when the user passes the trust score check */
  children: React.ReactNode;
  /** Shown while scan is idle or in-progress */
  fallback?: React.ReactNode;
  /** Shown when the score is below the configured threshold */
  blocked?: React.ReactNode;
}

/**
 * Gates its children behind the FHE trust score check.
 * Must be rendered inside a <FheGuardProvider>.
 */
export function FheGuardGate({ children, fallback, blocked }: FheGuardGateProps) {
  const { isAllowed, isLoading, status } = useFheGuardContext();

  if (status === 'idle' || isLoading) return <>{fallback ?? null}</>;
  if (status === 'complete' && !isAllowed) return <>{blocked ?? null}</>;
  if (status === 'complete' && isAllowed) return <>{children}</>;
  // error or other transitional states — keep showing fallback
  return <>{fallback ?? null}</>;
}
