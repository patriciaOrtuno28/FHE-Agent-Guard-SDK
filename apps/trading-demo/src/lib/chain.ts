'use client';

/** FHEVM ACL contract on Sepolia — grants/checks decryption permissions. */
export const FHEVM_ACL_SEPOLIA = '0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D' as const;

export const ACL_ABI = [
  {
    name: 'allow',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handle',  type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [],
  },
] as const;

/** Read the current chain ID from MetaMask. */
export async function getChainId(): Promise<number | null> {
  if (typeof window === 'undefined' || !window.ethereum) return null;
  try {
    const hex = await window.ethereum.request<string>({ method: 'eth_chainId' });
    return parseInt(hex, 16);
  } catch {
    return null;
  }
}

/** Poll until a transaction is mined (throws if reverted or timeout). */
export async function waitForReceipt(txHash: string, maxWaitMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const receipt = await window.ethereum!.request<{ status: string } | null>({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) {
      if (receipt.status === '0x0') throw new Error('Transaction reverted on-chain.');
      return;
    }
  }
  throw new Error('Transaction not mined within 2 minutes.');
}
