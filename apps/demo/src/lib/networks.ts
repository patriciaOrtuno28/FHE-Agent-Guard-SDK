export const NETWORKS = [
  {
    id:         'sepolia'   as const,
    chainId:    11155111,
    label:      'Sepolia Testnet',
    shortLabel: 'Sepolia',
    color:      'text-violet-400',
    border:     'border-violet-500/60',
    bg:         'bg-violet-950/30',
  },
  {
    id:         'mainnet'   as const,
    chainId:    1,
    label:      'Ethereum Mainnet',
    shortLabel: 'Mainnet',
    color:      'text-blue-400',
    border:     'border-blue-500/60',
    bg:         'bg-blue-950/30',
  },
  {
    id:         'localhost' as const,
    chainId:    31337,
    label:      'Localhost (Hardhat)',
    shortLabel: 'Local',
    color:      'text-zinc-400',
    border:     'border-zinc-600/60',
    bg:         'bg-zinc-900/30',
  },
] as const;

export type NetworkId = typeof NETWORKS[number]['id'];

export function networkByChainId(chainId: number) {
  return NETWORKS.find((n) => n.chainId === chainId) ?? null;
}
