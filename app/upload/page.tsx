'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { AdminHeader, useAdmin } from '@/components/admin-session';
import {
  Upload,
  FileSpreadsheet,
  Check,
  ArrowRight,
  Database,
  History,
  RotateCcw,
  Loader2,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Picker } from '@/components/picker';
import type {
  Preview,
  ImportHistory,
  GeoProperties,
  GeoData,
} from '@/lib/models';
import { api, post, number, percent, errorMessage } from '@/lib/api';
type Job = Preview & {
  status: string;
  phase: string;
  error?: string;
  retryable?: boolean;
  added?: number;
};
type Task = ImportHistory & {
  job_status: string;
  phase: string;
  error?: string;
  retryable?: boolean;
};
const jobLabels: Record<string, string> = {
  queued: '排队中',
  running: '处理中',
  ready: '待确认',
  failed: '处理失败',
  succeeded: '已入库',
  cancelled: '已取消',
  expired: '已过期',
};
const localDate = () => new Date().toLocaleDateString('sv-SE');
const displayTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false });
export default function UploadPage() {
  const user = useAdmin();
  const [tab, setTab] = useState('upload'),
    [date, setDate] = useState(localDate),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState(''),
    [history, setHistory] = useState<ImportHistory[]>([]),
    [withdraw, setWithdraw] = useState<ImportHistory | null>(null),
    [drag, setDrag] = useState(false);
  const [province, setProvince] = useState(''),
    [city, setCity] = useState(''),
    [county, setCounty] = useState('');
  const [provinces, setProvinces] = useState<GeoProperties[]>([]),
    [cities, setCities] = useState<GeoProperties[]>([]),
    [counties, setCounties] = useState<GeoProperties[]>([]);
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  const [taskTotal, setTaskTotal] = useState(0);
  const [geoBusy, setGeoBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const r = await api<{ items: ImportHistory[]; total: number }>(
      '/imports?page=' + page,
    );
    setHistory(r.items);
    setTotal(r.total);
  }, [page]);
  const loadTasks = useCallback(async () => {
    const r = await api<{ items: Task[]; total: number }>(
      '/jobs?page=' + taskPage,
    );
    setTasks(r.items);
    setTaskTotal(r.total);
  }, [taskPage]);
  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
  }, [load]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (live) loadTasks().catch((e) => setError(errorMessage(e)));
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [loadTasks]);
  useEffect(() => {
    if (!jobId) return;
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await api<Job>('/jobs/' + jobId, { signal: c.signal });
        if (c.signal.aborted) return;
        setJob(j);
        if (j.status === 'ready') {
          setPreview(j);
          setBusy(false);
        } else if (j.status === 'succeeded') {
          setPreview(null);
          setBusy(false);
          setSuccess(`提交成功：${j.added} 个有效试剂已入库。`);
          await load();
        } else if (['failed', 'expired', 'cancelled'].includes(j.status)) {
          setPreview(null);
          setBusy(false);
          if (j.error) setError(j.error);
        } else timer = setTimeout(poll, 1500);
      } catch (e) {
        if (!c.signal.aborted) {
          setBusy(false);
          setError(errorMessage(e));
          timer = setTimeout(poll, 5000);
        }
      }
    };
    void poll();
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [jobId, load]);
  useEffect(() => {
    api<GeoData>('/geo?code=100000')
      .then((g) =>
        setProvinces(
          g.features
            .map((f) => f.properties)
            .filter((p) => p.level === 'province'),
        ),
      )
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    if (!province) return;
    const c = new AbortController();
    setGeoBusy(true);
    api<GeoData>('/geo?code=' + province, { signal: c.signal })
      .then((g) => {
        if (['110000', '120000', '310000', '500000'].includes(province)) {
          const p = provinces.find((p) => String(p.adcode) === province)!;
          setCities([p]);
          setCity(province);
        } else
          setCities(
            g.features
              .map((f) => f.properties)
              .filter((p) => p.level === 'city'),
          );
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(errorMessage(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setGeoBusy(false);
      });
    return () => c.abort();
  }, [province, provinces]);
  useEffect(() => {
    if (!city) return;
    const c = new AbortController();
    api<GeoData>('/geo?code=' + city, { signal: c.signal })
      .then((g) =>
        setCounties(
          g.features
            .map((f) => f.properties)
            .filter((p) => p.level === 'district'),
        ),
      )
      .catch((e) => {
        if (e.name !== 'AbortError') setError(errorMessage(e));
      });
    return () => c.abort();
  }, [city]);
  const chooseFile = (f: File | undefined) => {
    if (!f) return;
    setError('');
    setSuccess('');
    setPreview(null);
    if (!f.name.toLowerCase().endsWith('.xlsx') || f.size > 8 * 1024 * 1024) {
      setError('请选择不超过 8 MB 的 .xlsx 文件。');
      setFile(null);
      return;
    }
    setFile(f);
  };
  const parse = async () => {
    if (!file || !city || !date) return;
    setBusy(true);
    setError('');
    setSuccess('');
    setPreview(null);
    try {
      const result = await api<{ id: string }>(
        '/imports/preview?' +
          new URLSearchParams({
            province_code: province,
            city_code: city,
            county_code: county,
            date,
            filename: file.name,
          }),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: await file.arrayBuffer(),
        },
      );
      setJobId(result.id);
      setJob(null);
      await loadTasks();
      setFile(null);
      if (input.current) input.current.value = '';
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await post('/imports/commit', { id: preview.id });
      const id = preview.id;
      setPreview(null);
      setJob({ id, status: 'queued', phase: 'commit' } as Job);
      setJobId('');
      setTimeout(() => setJobId(id), 0);
      await loadTasks();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const invalidate = async () => {
    if (!withdraw) return;
    setBusy(true);
    setError('');
    try {
      await post('/imports/withdraw', { id: withdraw.id });
      setWithdraw(null);
      await load();
      setSuccess('整批提交已作废，数据已退出统计，历史记录继续保留。');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="admin">
      <AdminHeader />
      <div className="admin-body">
        <div className="admin-heading">
          <div>
            <p className="eyebrow">DATA WORKSPACE</p>
            <h1>检测数据管理</h1>
            <p>按行政区提交检测结果，校验汇总后确认入库。</p>
          </div>
          <div className="workspace-tag">
            <Database size={16} />
            数据工作台
          </div>
        </div>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(String(v));
            setError('');
          }}
        >
          <TabsList variant="line" className="admin-tabs">
            <TabsTrigger value="upload">
              <Upload />
              上传结果
            </TabsTrigger>
            <TabsTrigger value="history">
              <History />
              {user?.role === 'superadmin' ? '全部提交记录' : '我的提交记录'}
            </TabsTrigger>
          </TabsList>
          {error && (
            <div className="admin-error whitespace-pre-line" role="alert">
              {error}
            </div>
          )}
          {success && (
            <output className="admin-success">
              <Check size={17} />
              {success}
            </output>
          )}
          <TabsContent value="upload">
            <section className="admin-table-card" aria-label="上传任务">
              <div className="table-toolbar">
                <div>
                  <h2>上传任务</h2>
                  <p>
                    关闭页面后仍会继续处理，可在这里查看结果。预览保留 7 天。
                  </p>
                </div>
              </div>
              {job && (
                <output>
                  当前任务：{job.phase === 'commit' ? '入库' : '解析'} ·{' '}
                  {jobLabels[job.status] || job.status}
                </output>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>文件／批次</TableHead>
                    <TableHead>提交人</TableHead>
                    <TableHead>进度</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        {t.file_name}
                        <small className="code-note">{t.id}</small>
                      </TableCell>
                      <TableCell>{t.submitted_name}</TableCell>
                      <TableCell>
                        {t.phase === 'commit' ? '入库' : '解析'} ·{' '}
                        {jobLabels[t.job_status] || t.job_status}
                        {t.error && (
                          <p className="whitespace-pre-line">{t.error}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setError('');
                            setJobId('');
                            setTimeout(() => setJobId(t.id), 0);
                          }}
                        >
                          查看结果
                        </Button>
                        {t.phase === 'parse' &&
                          ['queued', 'running', 'ready', 'failed'].includes(
                            t.job_status,
                          ) && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                try {
                                  await post('/jobs/cancel', { id: t.id });
                                  if (jobId === t.id) {
                                    setJobId('');
                                    setJob(null);
                                    setPreview(null);
                                  }
                                  await loadTasks();
                                } catch (e) {
                                  setError(errorMessage(e));
                                }
                              }}
                            >
                              取消
                            </Button>
                          )}
                        {t.job_status === 'failed' && t.retryable && (
                          <Button
                            size="sm"
                            onClick={async () => {
                              try {
                                await post('/jobs/retry', { id: t.id });
                                setJobId('');
                                setTimeout(() => setJobId(t.id), 0);
                                await loadTasks();
                              } catch (e) {
                                setError(errorMessage(e));
                              }
                            }}
                          >
                            重试入库
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!tasks.length && <p className="admin-empty">暂无待处理任务</p>}
              <div className="table-toolbar">
                <Button
                  variant="outline"
                  disabled={taskPage === 1}
                  onClick={() => setTaskPage((p) => p - 1)}
                >
                  上一页
                </Button>
                <span>
                  第 {taskPage} 页 · 共 {taskTotal} 条
                </span>
                <Button
                  variant="outline"
                  disabled={taskPage * 20 >= taskTotal}
                  onClick={() => setTaskPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
            </section>
            <div className="upload-grid">
              <section className="upload-card">
                <div className="step-header">
                  <span className="step-number">01</span>
                  <div>
                    <h2>选择检测地区和日期</h2>
                    <p>至少选择到市，区县可选；整份文件使用同一检测日期。</p>
                  </div>
                </div>
                <div className="upload-fields">
                  <div>
                    <Label>省份</Label>
                    <Picker
                      value={province}
                      label="选择省份"
                      disabled={busy}
                      options={provinces.map((p) => ({
                        value: String(p.adcode),
                        label: p.name,
                      }))}
                      onChange={(v) => {
                        setProvince(v);
                        setCity('');
                        setCounty('');
                        setCities([]);
                        setCounties([]);
                        setPreview(null);
                      }}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label>城市（必选）</Label>
                    <Picker
                      value={city}
                      label="选择城市"
                      disabled={busy || geoBusy || !province}
                      options={cities.map((p) => ({
                        value: String(p.adcode),
                        label: p.name,
                      }))}
                      onChange={(v) => {
                        setCity(v);
                        setCounty('');
                        setCounties([]);
                        setPreview(null);
                      }}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label>区／县（可选）</Label>
                    <Picker
                      value={county || 'city-only'}
                      label="不填写，仅到市"
                      disabled={busy || !city}
                      options={[
                        { value: 'city-only', label: '不填写，仅到市' },
                        ...counties.map((p) => ({
                          value: String(p.adcode),
                          label: p.name,
                        })),
                      ]}
                      onChange={(v) => {
                        setCounty(v === 'city-only' ? '' : v);
                        setPreview(null);
                      }}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <Label htmlFor="detection-date">检测日期</Label>
                    <Input
                      id="detection-date"
                      type="date"
                      value={date}
                      disabled={busy}
                      onChange={(e) => {
                        setDate(e.target.value);
                        setPreview(null);
                      }}
                    />
                  </div>
                </div>
                <div className="step-header second-step">
                  <span className="step-number">02</span>
                  <div>
                    <h2>上传检测 Excel</h2>
                    <p>只读取 Sheet1，其他工作表不参与解析。</p>
                  </div>
                </div>
                <div
                  className={'dropzone ' + (drag ? 'dragging' : '')}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!busy) setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    if (!busy) chooseFile(e.dataTransfer.files[0]);
                  }}
                >
                  <div className="file-icon">
                    <FileSpreadsheet size={30} />
                  </div>
                  <strong>
                    {file
                      ? file.name
                      : preview
                        ? '解析已完成，请核对下方汇总'
                        : '将 Excel 拖到这里'}
                  </strong>
                  <p>支持 .xlsx，最大 8 MB；Sheet1 最多 30,000 个非空数据行</p>
                  <input
                    ref={input}
                    type="file"
                    accept=".xlsx"
                    className="sr-only"
                    aria-label="上传检测 Excel 文件"
                    disabled={busy}
                    onChange={(e) => chooseFile(e.target.files?.[0])}
                  />
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => input.current?.click()}
                  >
                    选择文件
                  </Button>
                </div>
                <div className="upload-bottom">
                  <span>
                    <Info size={14} />原 Excel 解析后不保留
                  </span>
                  <Button
                    disabled={!file || !city || !date || busy || geoBusy}
                    onClick={parse}
                  >
                    {busy ? <Loader2 className="spinning" /> : null}解析并预览
                    <ArrowRight />
                  </Button>
                </div>
              </section>
              <aside className="upload-guide">
                <h2>每次提交独立累计</h2>
                <p>
                  重复上传会重复计数。需要纠错时，请在提交记录中作废旧批次，再上传正确文件。
                </p>
                <div className="guide-flow">
                  <span>
                    <FileSpreadsheet />
                    读取 Sheet1
                  </span>
                  <i>↓</i>
                  <span>
                    <Check />
                    校验并核对汇总
                  </span>
                  <i>↓</i>
                  <span>
                    <Database />
                    确认后计入大盘
                  </span>
                </div>
                <div className="rules">
                  <h3>检测结果口径</h3>
                  <p>数值 CT：阳性；“阴性”：阴性。</p>
                  <p>CT 为 -／— 或病原体为 N：整行剔除。</p>
                  <small>
                    同一试剂可检测多个病原体。有效行的 batch + sam +
                    病原体重复时，必须修正后重传。
                  </small>
                </div>
                <p className="field-hint">
                  仅填写市的数据参与全国和省级统计，进入市内区县视图后不计入。
                </p>
              </aside>
            </div>
            {preview && (
              <section className="preview-card">
                <div className="preview-heading">
                  <div>
                    <h2>确认本次提交</h2>
                    <p>
                      {preview.location.province} / {preview.location.city}
                      {preview.location.county
                        ? ' / ' + preview.location.county
                        : '（仅到市）'}{' '}
                      · 检测日期 {preview.date}
                    </p>
                    <small className="code-note">
                      上传批次号：{preview.id}
                    </small>
                  </div>
                  <Button disabled={busy} onClick={commit}>
                    {busy ? <Loader2 className="spinning" /> : <Check />}
                    确认提交
                  </Button>
                </div>
                <div className="preview-stats">
                  {[
                    ['有效结果行', number(preview.summary.rows)],
                    ['有效试剂', number(preview.summary.tested)],
                    ['阳性试剂', number(preview.summary.positive)],
                    ['剔除行', number(preview.summary.excluded)],
                    ['试剂阳性率', percent(preview.summary.rate)],
                  ].map(([l, v]) => (
                    <div key={l}>
                      <span>{l}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
                {preview.warnings.map((w) => (
                  <p className="import-warning" key={w}>
                    <Info size={14} />
                    {w}
                  </p>
                ))}
                <p className="field-hint">
                  当前尚未参与统计，确认后整批生效。预览保留 7
                  天，逾期需重新上传。
                </p>
              </section>
            )}
          </TabsContent>
          <TabsContent value="history">
            <section className="admin-table-card">
              <div className="table-toolbar">
                <div>
                  <h2>
                    {user?.role === 'superadmin'
                      ? '全部提交记录'
                      : '我的提交记录'}
                  </h2>
                  <p>按整份提交管理；作废保留历史，不恢复其他提交的旧版本。</p>
                </div>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => load().catch((e) => setError(errorMessage(e)))}
                >
                  <RotateCcw />
                  刷新
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    {[
                      '文件／上传批次号',
                      '检测地区',
                      '检测日期',
                      '提交人／提交时间',
                      '有效数据',
                      '状态／作废信息',
                      '操作',
                    ].map((v) => (
                      <TableHead key={v}>{v}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell>
                        {h.file_name}
                        <small className="code-note break-all">{h.id}</small>
                      </TableCell>
                      <TableCell>
                        {h.province} / {h.city}
                        <small className="code-note">
                          {h.county || '仅到市'}
                        </small>
                      </TableCell>
                      <TableCell>{h.report_date}</TableCell>
                      <TableCell>
                        {h.submitted_name}
                        {h.submitted_username
                          ? '（' + h.submitted_username + '）'
                          : ''}
                        <small className="code-note">
                          {displayTime(h.created_at)}
                        </small>
                      </TableCell>
                      <TableCell>
                        {number(h.summary.tested)} 个试剂 ·{' '}
                        {number(h.summary.positive)} 个阳性
                        <small className="code-note">
                          {number(h.summary.rows)} 行结果 / 剔除{' '}
                          {number(h.summary.excluded)} 行
                        </small>
                      </TableCell>
                      <TableCell>
                        <span
                          className={
                            'result-status ' +
                            (h.status === 'published' ? 'negative' : 'untested')
                          }
                        >
                          {h.status === 'published' ? '已提交' : '已作废'}
                        </span>
                        {h.withdrawn_at && (
                          <small className="code-note">
                            {h.withdrawn_name}
                            <br />
                            {displayTime(h.withdrawn_at)}
                          </small>
                        )}
                      </TableCell>
                      <TableCell>
                        {h.status === 'published' && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => setWithdraw(h)}
                          >
                            作废整批
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="table-toolbar">
                <Button
                  variant="outline"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  上一页
                </Button>
                <span>
                  第 {page} 页 · 共 {total} 条
                </span>
                <Button
                  variant="outline"
                  disabled={page * 20 >= total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </Button>
              </div>
              {!history.length && (
                <div className="admin-empty">暂无提交记录</div>
              )}
            </section>
          </TabsContent>
        </Tabs>
      </div>
      <AlertDialog
        open={!!withdraw}
        onOpenChange={(v) => {
          if (!v && !busy) setWithdraw(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>作废整批提交？</AlertDialogTitle>
            <AlertDialogDescription>
              {withdraw?.file_name}{' '}
              的全部有效数据将退出大盘统计，历史汇总继续保留。此操作不会影响其他上传批次。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <Button disabled={busy} onClick={invalidate}>
              {busy ? '正在作废…' : '确认作废'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
