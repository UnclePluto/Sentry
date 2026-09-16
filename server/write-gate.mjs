// 所有业务写事务先锁版本行，再锁账号/会话、任务、批次。
// 直接使用排他行锁，避免多个写事务由共享锁升级时相互等待。
export async function lockWrites(tx, { allowMaintenance = false } = {}) {
  const state = await tx.get(
    'SELECT maintenance FROM dataset_state WHERE id=1 FOR UPDATE',
  );
  if (state.maintenance && !allowMaintenance)
    throw Object.assign(Error('系统维护中，暂时停止写入。'), { status: 503 });
}
export async function authorizeWrite(tx, user) {
  await lockWrites(tx);
  const current = await tx.get(
    `SELECT u.id FROM admin_users u JOIN admin_sessions s ON s.user_id=u.id WHERE u.id=$1 AND u.enabled=1 AND s.token_hash=$2 AND s.expires_at>$3 FOR SHARE OF u,s`,
    user.id,
    user.session_hash || '',
    Date.now(),
  );
  if (!current)
    throw Object.assign(Error('登录状态已失效，请重新登录。'), { status: 401 });
}
