import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FHE Agent Guard — Demo',
  description: 'Privacy-preserving on-chain anomaly detection using Fully Homomorphic Encryption',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
