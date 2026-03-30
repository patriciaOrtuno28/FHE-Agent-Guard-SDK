export const NETWORKS = [
  {
    id: 'sepolia' as const,
    chainId: 11155111,
    label: 'Sepolia Testnet',
    shortLabel: 'Sepolia',
    color: 'text-violet-400',
    border: 'border-violet-500/60',
    bg: 'bg-violet-950/30',
    disabled: false,
    badge: 'FHE',
  },
  {
    id: 'mainnet' as const,
    chainId: 1,
    label: 'Ethereum Mainnet',
    shortLabel: 'Mainnet',
    color: 'text-blue-400',
    border: 'border-blue-500/60',
    bg: 'bg-blue-950/30',
    disabled: true,
    badge: 'Coming Soon',
  },
] as const;

export type NetworkId = typeof NETWORKS[number]['id'];

export function networkByChainId(chainId: number) {
  return NETWORKS.find((n) => n.chainId === chainId) ?? null;
}
