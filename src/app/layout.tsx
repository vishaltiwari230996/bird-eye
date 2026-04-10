import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bird Eye — Competitor Monitor',
  description: 'Monitor Amazon & Flipkart competitor listings in real time',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
