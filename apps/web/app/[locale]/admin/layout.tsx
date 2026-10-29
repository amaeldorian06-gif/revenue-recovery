import type { Metadata } from 'next';

/** Platform-admin surfaces: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
