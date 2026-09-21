export async function checkSampleModelReadiness(db) {
  const row = await db.get(
    `SELECT
       count(*) FILTER(WHERE status='published')::bigint AS published,
       count(*) FILTER(WHERE status='staged')::bigint AS unfinished
     FROM imports
     WHERE format_version=1 AND demo=0`,
  );
  const publishedLegacy = Number(row?.published || 0);
  const unfinishedLegacy = Number(row?.unfinished || 0);
  return {
    ready: publishedLegacy === 0 && unfinishedLegacy === 0,
    publishedLegacy,
    unfinishedLegacy,
  };
}

export const sampleModelNotReady = () =>
  Object.assign(
    Error('历史检测数据尚未完成新口径核对，暂不能展示新版统计。'),
    {
      status: 503,
      expose: true,
      code: 'SAMPLE_MODEL_NOT_READY',
    },
  );
