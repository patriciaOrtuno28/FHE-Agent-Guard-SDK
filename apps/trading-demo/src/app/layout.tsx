import type { Metadata } from 'next';
import './globals.css';
import { FheGuardProvider } from '@fhe-guard/plugin';

// The admin-configured minimum score. In a real deployment this would come
// from a database or environment variable. Here it's set via NEXT_PUBLIC_REQUIRED_SCORE.
const REQUIRED_SCORE = Number(process.env.NEXT_PUBLIC_REQUIRED_SCORE ?? 7);

export const metadata: Metadata = {
  title: 'FHE TradeSafe — Privacy-First Trading',
  description:
    'Decentralised trading platform protected by Fully Homomorphic Encryption trust scoring. Your data stays private — always.',
  icons: {
    icon: '/favicon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <FheGuardProvider threshold={REQUIRED_SCORE} network="sepolia">
          {children}
        </FheGuardProvider>
      </body>
    </html>
  );
}
