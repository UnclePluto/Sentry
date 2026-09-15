'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { api, post, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Activity } from 'lucide-react';
export type AdminUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'superadmin';
  enabled: boolean;
  createdAt: string;
};
const Session = createContext<AdminUser | null>(null);
export const useAdmin = () => useContext(Session);
export function AdminSession({
  children,
  superOnly = false,
}: {
  children: React.ReactNode;
  superOnly?: boolean;
}) {
  const [user, setUser] = useState<AdminUser | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    api<AdminUser>('/auth/me', { signal: c.signal })
      .then(setUser)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, []);
  if (!user)
    return (
      <main className="admin auth-wait">
        {error || '正在验证登录状态…'}
        {error && <a href="/login">前往登录</a>}
      </main>
    );
  if (superOnly && user.role !== 'superadmin')
    return (
      <main className="admin auth-wait">
        此页面仅限超级管理员使用。<a href="/upload">返回数据管理</a>
      </main>
    );
  return <Session.Provider value={user}>{children}</Session.Provider>;
}
export function AdminHeader() {
  const user = useAdmin();
  const [open, setOpen] = useState(false),
    [old, setOld] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function change(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/password', { currentPassword: old, password });
      window.location.assign('/login?changed=1');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await post('/auth/logout', {});
      window.location.assign('/login');
    } catch (e) {
      setError(errorMessage(e));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header className="admin-header">
        <div className="brand">
          <Activity />
          <strong>
            SENTRY<span>检测数据管理平台</span>
          </strong>
        </div>
        <nav>
          <a href="/upload">数据管理</a>
          {user?.role === 'superadmin' && <a href="/accounts">管理员账号</a>}
        </nav>
        <div className="admin-identity">
          <span>
            {user?.displayName}
            <small>
              {user?.role === 'superadmin' ? '超级管理员' : '管理员'}
            </small>
          </span>
          <Button
            variant="outline"
            onClick={() => {
              setError('');
              setOpen(true);
            }}
          >
            修改密码
          </Button>
          <Button variant="ghost" disabled={busy} onClick={logout}>
            退出登录
          </Button>
        </div>
      </header>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) {
            setOld('');
            setPassword('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改自己的密码</DialogTitle>
            <DialogDescription>
              密码修改后，所有已登录会话会失效，请重新登录。
            </DialogDescription>
          </DialogHeader>
          <form className="account-form" onSubmit={change}>
            <Label htmlFor="old-password">当前密码</Label>
            <Input
              id="old-password"
              type="password"
              autoComplete="current-password"
              value={old}
              onChange={(e) => setOld(e.target.value)}
              required
            />
            <Label htmlFor="own-password">新密码</Label>
            <Input
              id="own-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              maxLength={128}
              required
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button disabled={busy} type="submit">
              {busy ? '正在保存…' : '保存并重新登录'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
