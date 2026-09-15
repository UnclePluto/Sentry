'use client';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { post, errorMessage } from '@/lib/api';
export default function Login() {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/login', { username, password });
      window.location.assign('/upload');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin admin-login">
      <section className="login-panel">
        <div className="login-mark">
          <ShieldCheck size={28} />
          <span>SENTRY / DATA WORKSPACE</span>
        </div>
        <h1>管理员登录</h1>
        <p>登录后管理检测数据与上传结果。</p>
        <form className="account-form" onSubmit={submit}>
          <Label htmlFor="login-username">管理员账号</Label>
          <Input
            id="login-username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={32}
            required
            autoFocus
          />
          <Label htmlFor="login-password">密码</Label>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={128}
            required
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? '正在登录…' : '登录后台'}
          </Button>
        </form>
        <small>账号由超级管理员创建和维护。</small>
      </section>
    </main>
  );
}
