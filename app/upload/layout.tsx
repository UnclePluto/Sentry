import type { Metadata } from 'next';
import { AdminSession } from '@/components/admin-session';

export const metadata: Metadata = { title: '检测数据管理 · SENTRY' };

export default function ManagementLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AdminSession>{children}</AdminSession>;
}
