import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: '病原体流行演变监测大屏 · SENTRY',
  description: '病原体空间分布与流行演变监测',
  icons: { icon: '/favicon.svg' },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
