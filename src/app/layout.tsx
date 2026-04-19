import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Cormorant_Garamond } from 'next/font/google';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
});

const serifDisplay = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-serif-display',
});

export const metadata: Metadata = {
  title: 'Bird Eye — Listing Observatory',
  description: 'A quiet observatory for Amazon and Flipkart listings.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${jakarta.variable} ${serifDisplay.variable} app-shell`}>{children}</body>
    </html>
  );
}
