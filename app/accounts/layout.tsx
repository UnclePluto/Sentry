import type { Metadata } from 'next';
import { AdminSession } from '@/components/admin-session';
export const metadata: Metadata = { title: '管理员账号 · SENTRY' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <AdminSession superOnly>{children}</AdminSession>;
}
