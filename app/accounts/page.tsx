'use client';
import { useEffect, useState } from 'react';
import { AdminHeader, type AdminUser } from '@/components/admin-session';
import { api, post, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
export default function Accounts() {
  const [users, setUsers] = useState<AdminUser[]>([]),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [reset, setReset] = useState<AdminUser | null>(null),
    [remove, setRemove] = useState<AdminUser | null>(null),
    [username, setUsername] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState('');
  const load = () => api<AdminUser[]>('/admins').then(setUsers);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function mutate(
    id: string,
    action: string,
    extra: Record<string, string> = {},
  ) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await post('/admins/' + id, { action, ...extra });
      await load();
      setMessage('账号设置已更新。');
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reset) {
      if (await mutate(reset.id, 'reset-password', { password })) {
        setReset(null);
        setPassword('');
      }
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/admins', { username, displayName: name, password });
      await load();
      setCreate(false);
      setUsername('');
      setName('');
      setPassword('');
      setMessage('管理员已创建，可以使用新账号登录。');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin">
      <AdminHeader />
      <div className="admin-body">
        <div className="admin-heading">
          <div>
            <p className="eyebrow">ACCESS MANAGEMENT</p>
            <h1>管理员账号</h1>
            <p>普通管理员仅管理本人的提交记录，超管可查看全部；账号由超管维护。</p>
          </div>
          <Button
            onClick={() => {
              setError('');
              setPassword('');
              setCreate(true);
            }}
          >
            新增管理员
          </Button>
        </div>
        {error && !create && !reset && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="admin-success" role="status">
            {message}
          </p>
        )}
        <div className="accounts-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>账号</TableHead>
                <TableHead>姓名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>{user.username}</TableCell>
                  <TableCell>{user.displayName}</TableCell>
                  <TableCell>
                    {user.role === 'superadmin' ? '超级管理员' : '管理员'}
                  </TableCell>
                  <TableCell>{user.enabled ? '启用' : '已停用'}</TableCell>
                  <TableCell>
                    {new Date(user.createdAt).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell>
                    {user.role === 'superadmin' ? (
                      <span className="account-muted">受保护账号</span>
                    ) : (
                      <div className="account-actions">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              user.id,
                              user.enabled ? 'disable' : 'enable',
                            )
                          }
                        >
                          {user.enabled ? '停用' : '启用'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setError('');
                            setPassword('');
                            setReset(user);
                          }}
                        >
                          重置密码
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRemove(user)}
                        >
                          删除
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      <Dialog
        open={create || Boolean(reset)}
        onOpenChange={(v) => {
          if (!v) {
            setCreate(false);
            setReset(null);
            setPassword('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reset ? '重置管理员密码' : '新增管理员'}</DialogTitle>
            <DialogDescription>
              {reset
                ? `为 ${reset.username} 设置新密码，旧登录会话立即失效。`
                : '账号创建后即可登录后台。密码至少 12 个字符。'}
            </DialogDescription>
          </DialogHeader>
          <form className="account-form" onSubmit={submit}>
            {!reset && (
              <>
                <Label htmlFor="new-username">登录账号</Label>
                <Input
                  id="new-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  minLength={3}
                  maxLength={32}
                  required
                />
                <Label htmlFor="new-name">管理员姓名</Label>
                <Input
                  id="new-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={40}
                  required
                />
              </>
            )}
            <Label htmlFor="new-password">
              {reset ? '新密码' : '初始密码'}
            </Label>
            <Input
              id="new-password"
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
            <Button type="submit" disabled={busy}>
              {busy ? '正在保存…' : '保存'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(remove)}
        onOpenChange={(v) => {
          if (!v) setRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除管理员 {remove?.username}？</AlertDialogTitle>
            <AlertDialogDescription>
              该账号将无法登录，已上传的检测数据会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                if (remove)
                  void mutate(remove.id, 'delete').then((ok) => {
                    if (ok) setRemove(null);
                  });
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
