'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Atom,
  ChevronRight,
  Play,
  Pause,
  Globe2,
  RefreshCw,
  Maximize2,
  CalendarDays,
  Radio,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Picker } from '@/components/picker';
import { api, number, percent } from '@/lib/api';
import type { DashboardData, ModelContext, GeoData } from '@/lib/models';
import type { Region } from '@/components/map-view';
import type { MapJourney } from '@/components/map-transition';
import './dashboard.css';
const MapView = dynamic(() => import('@/components/map-view'), { ssr: false });
const Chart = dynamic(() => import('@/components/chart'), { ssr: false });
const ROOT: Region = {
  code: '100000',
  name: '全国',
  level: 'country',
  center: [104.5, 35.2],
};
const axis = {
  axisLabel: { color: '#749fb7', fontSize: 12 },
  axisLine: { lineStyle: { color: '#24465e' } },
  axisTick: { show: false },
  splitLine: { lineStyle: { color: '#173043', type: 'dashed' } },
};
const safe = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] || c,
  );
function period(m: string) {
  return m
    ? {
        from: m + '-01',
        to: new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0))
          .toISOString()
          .slice(0, 10),
      }
    : { from: '', to: '' };
}
export default function Dashboard() {
  const [demo, setDemo] = useState(true),
    [data, setData] = useState<DashboardData | null>(null),
    [overview, setOverview] = useState<DashboardData | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [range, setRange] = useState({ from: '', to: '' }),
    [pathogen, setPathogen] = useState(''),
    [path, setPath] = useState<Region[]>([ROOT]),
    [playing, setPlaying] = useState(true),
    [month, setMonth] = useState(''),
    [refresh, setRefresh] = useState(0),
    [now, setNow] = useState(''),
    [customDates, setCustomDates] = useState(false);
  const [mapMode, setMapMode] = useState<'2d' | '3d'>('3d');
  const [navigation, setNavigation] = useState<
    (MapJourney & { path: Region[]; geo: GeoData; data: DashboardData }) | null
  >(null);
  const [arrival, setArrival] = useState<MapJourney | null>(null);
  const [preparedGeo, setPreparedGeo] = useState<GeoData | null>(null);
  const navigationRequest = useRef<AbortController | null>(null);
  const [navigating, setNavigating] = useState(false);
  const initialized = useRef(false);
  const region = path[path.length - 1];
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('source') === 'real')
      setDemo(false);
    const tick = () =>
      setNow(new Date().toLocaleString('zh-CN', { hour12: false }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const c = new AbortController();
    api<DashboardData>(
      '/dashboard?' +
        new URLSearchParams({
          demo: demo ? '1' : '0',
          region: region.code,
          pathogen,
        }),
      { signal: c.signal },
    )
      .then((value) => {
        setOverview(value);
        if (!initialized.current && value.extent.latest) {
          initialized.current = true;
          const m = value.extent.latest.slice(0, 7);
          setMonth(m);
          setRange(period(m));
        }
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [demo, region.code, pathogen, refresh]);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError('');
    api<DashboardData>(
      '/dashboard?' +
        new URLSearchParams({
          demo: demo ? '1' : '0',
          ...range,
          region: region.code,
          pathogen,
        }),
      { signal: c.signal },
    )
      .then(setData)
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setError(e.message);
          setData(null);
        }
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [demo, range, region.code, pathogen, refresh]);
  const months = useMemo(() => {
    const a = overview?.extent.earliest?.slice(0, 7),
      b = overview?.extent.latest?.slice(0, 7);
    if (!a || !b) return [];
    const result = [];
    const cursor = new Date(a + '-01T00:00:00Z');
    while (cursor.toISOString().slice(0, 7) <= b && result.length < 120) {
      result.push(cursor.toISOString().slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return result;
  }, [overview?.extent.earliest, overview?.extent.latest]);
  useEffect(() => {
    if (!playing || months.length < 2 || loading || navigating) return;
    const t = setTimeout(() => {
      const m = months[(months.indexOf(month) + 1) % months.length];
      setMonth(m);
      setRange(period(m));
    }, 5000);
    return () => clearTimeout(t);
  }, [playing, months, month, loading, navigating]);
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext })
      .modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      context.registerTool(
        {
          name: 'read_surveillance_summary',
          description: '读取当前监测区域与时间范围的汇总数据，不含样本标识。',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: () => ({
            demo,
            region: region.name,
            ...range,
            metrics: data?.metrics || null,
          }),
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, [demo, data, region, range]);
  useEffect(() => {
    const t = setInterval(() => setRefresh((v) => v + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const chartData = overview;
  const trend = useMemo(
    () => ({
      animationDurationUpdate: 650,
      tooltip: { trigger: 'axis' },
      grid: { left: 35, right: 34, top: 14, bottom: 24 },
      xAxis: {
        type: 'category',
        data: chartData?.trend.map((r) => r.month.slice(5) + '月'),
        ...axis,
      },
      yAxis: [
        { type: 'value', ...axis },
        {
          type: 'value',
          ...axis,
          axisLabel: { color: '#ae87df', fontSize: 12, formatter: '{value}%' },
        },
      ],
      series: [
        {
          name: '有效检测',
          type: 'bar',
          data: chartData?.trend.map((r) => r.tested),
          barMaxWidth: 18,
          itemStyle: { color: '#166c86', borderRadius: [2, 2, 0, 0] },
        },
        {
          name: '试剂阳性率',
          type: 'line',
          yAxisIndex: 1,
          data: chartData?.trend.map((r) =>
            r.rate == null ? null : Number((r.rate * 100).toFixed(1)),
          ),
          smooth: true,
          symbolSize: 5,
          itemStyle: { color: '#d389fc' },
          lineStyle: { width: 2, shadowBlur: 9, shadowColor: '#ab53ff' },
          areaStyle: { color: '#b26bed', opacity: 0.12 },
        },
      ],
    }),
    [chartData],
  );
  const heat = useMemo(() => {
    const ranks = chartData?.ranking.slice(0, 8) || [];
    const ms = chartData?.trend.map((r) => r.month) || [];
    const values = ranks.flatMap((r, y) =>
      ms.map((m, x) => [
        x,
        y,
        chartData?.heatmap.find((v) => v.code === r.code && v.month === m)
          ?.count || 0,
      ]),
    );
    return {
      tooltip: {
        formatter: (p: { value: number[] }) =>
          `${safe(ranks[p.value[1]]?.name || '')}<br/>${ms[p.value[0]]} · ${p.value[2]} 份阳性试剂`,
      },
      grid: { left: 104, right: 6, top: 9, bottom: 24 },
      xAxis: {
        type: 'category',
        data: ms.map((m) => m.slice(5) + '月'),
        ...axis,
      },
      yAxis: {
        type: 'category',
        data: ranks.map((r) => r.name),
        ...axis,
        axisLabel: {
          color: '#93b7cd',
          fontSize: 12,
          width: 98,
          overflow: 'break',
          lineHeight: 14,
        },
      },
      visualMap: {
        show: false,
        min: 0,
        max: Math.max(1, ...values.map((v) => v[2])),
        inRange: {
          color: ['#102035', '#174b70', '#317c99', '#9561c7', '#ed9fe6'],
        },
      },
      series: [
        {
          type: 'heatmap',
          data: values,
          label: { show: ms.length <= 8, color: '#e2f1fe', fontSize: 12 },
          itemStyle: {
            borderColor: '#070f1e',
            borderWidth: 3,
            borderRadius: 2,
          },
        },
      ],
    };
  }, [chartData]);
  async function navigate(nextPath: Region[]) {
    if (navigationRequest.current || nextPath.at(-1)?.code === region.code)
      return;
    const controller = new AbortController();
    navigationRequest.current = controller;
    setNavigating(true);
    const target = nextPath[nextPath.length - 1];
    const direction = nextPath.length > path.length ? 'in' : 'out';
    const focusCode =
      direction === 'in' ? target.code : path[nextPath.length].code;
    try {
      const [geo, nextData] = await Promise.all([
        api<GeoData>('/geo?code=' + target.code, { signal: controller.signal }),
        api<DashboardData>(
          '/dashboard?' +
            new URLSearchParams({
              demo: demo ? '1' : '0',
              ...range,
              region: target.code,
              pathogen,
            }),
          { signal: controller.signal },
        ),
      ]);
      if (!controller.signal.aborted)
        setNavigation({
          direction,
          focusCode,
          path: nextPath,
          geo,
          data: nextData,
        });
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : '地图加载失败，请重试');
        navigationRequest.current = null;
        setNavigating(false);
      }
    }
  }
  function finishNavigation() {
    if (!navigation) return;
    setPreparedGeo(navigation.geo);
    setData(navigation.data);
    setArrival({
      direction: navigation.direction,
      focusCode: navigation.focusCode,
    });
    setPath(navigation.path);
    setNavigation(null);
    navigationRequest.current = null;
    setNavigating(false);
  }
  useEffect(() => () => navigationRequest.current?.abort(), []);
  const m = data?.metrics;
  const selectMonth = (value: string) => {
    setMonth(value);
    setRange(period(value));
    setPlaying(false);
    setCustomDates(false);
  };
  return (
    <main className="cyber-screen dark">
      <div className="cyber-ambient" aria-hidden="true">
        <div className="scan-grid" />
        <div className="scan-orbit orbit-one" />
        <div className="scan-orbit orbit-two" />
      </div>
      <div className="cyber-map">
        <MapView
          key={region.code}
          motionScope={`${demo}-${pathogen}`}
          region={region}
          mapMode={mapMode}
          onModeChange={setMapMode}
          regions={data?.regions}
          preparedGeo={preparedGeo}
          navigation={navigation}
          arrival={arrival}
          onTransitionEnd={finishNavigation}
          onDrill={(r) => {
            if (r.code !== region.code) void navigate([...path, r]);
          }}
        />
      </div>
      <header className="screen-header">
        <div className="screen-brand">
          <Atom size={30} />
          <div>
            <strong>SENTRY</strong>
            <span>PATHOGEN OBSERVATORY</span>
          </div>
        </div>
        <div className="screen-title">
          <div className="title-topline">
            <i /> 生物监测 · 时空演变 <i />
          </div>
          <h1>病原体流行演变监测大屏</h1>
          <p>PATHOGEN EPIDEMIOLOGICAL SURVEILLANCE</p>
        </div>
        <div className="screen-clock">
          <time suppressHydrationWarning>{now || 'SENTRY / LIVE'}</time>
          <div>
            <span className="signal-bars">
              <i />
              <i />
              <i />
              <i />
            </span>
            {demo ? '模拟数据演示' : '监测数据展示'}
            <Button
              variant="ghost"
              size="icon"
              aria-label="全屏显示大盘"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else
                  void document.documentElement
                    .requestFullscreen()
                    .catch(() => {});
              }}
            >
              <Maximize2 />
            </Button>
          </div>
        </div>
      </header>
      <section className="screen-toolbar">
        <div className="screen-breadcrumb">
          <Globe2 size={15} />
          {path.map((r, i) => (
            <span key={r.code}>
              {i > 0 && <ChevronRight size={13} />}
              <button
                disabled={navigating}
                onClick={() => void navigate(path.slice(0, i + 1))}
              >
                {r.name}
              </button>
            </span>
          ))}
        </div>
        <div className="screen-filters" inert={navigating}>
          <Picker
            value={pathogen || 'all'}
            onChange={(v) => setPathogen(v === 'all' ? '' : v)}
            options={[
              { value: 'all', label: '全部病原体' },
              ...(overview?.ranking || []).map((r) => ({
                value: r.code,
                label: r.name,
              })),
            ]}
            label="筛选病原体"
            contentClassName="cyber-popup"
          />
          <Picker
            value={demo ? 'demo' : 'real'}
            onChange={(v) => {
              navigationRequest.current?.abort();
              navigationRequest.current = null;
              setNavigation(null);
              setNavigating(false);
              setPreparedGeo(null);
              setArrival(null);
              initialized.current = false;
              setDemo(v === 'demo');
              setPathogen('');
              setMonth('');
              setRange({ from: '', to: '' });
              setPath([ROOT]);
              setOverview(null);
              setData(null);
            }}
            options={[
              { value: 'demo', label: '演示数据' },
              { value: 'real', label: '监测数据' },
            ]}
            label="数据来源"
            contentClassName="cyber-popup"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="选择报告日期范围"
            aria-expanded={customDates}
            onClick={() => setCustomDates(!customDates)}
          >
            <CalendarDays />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新监测数据"
            onClick={() => setRefresh((v) => v + 1)}
          >
            <RefreshCw className={loading ? 'spinning' : ''} />
          </Button>
        </div>
        {customDates && (
          <div className="screen-date-panel">
            <label htmlFor="report-from">
              开始日期
              <Input
                id="report-from"
                type="date"
                value={range.from}
                max={range.to || undefined}
                onChange={(e) => {
                  setRange({ ...range, from: e.target.value });
                  setMonth('');
                  setPlaying(false);
                }}
              />
            </label>
            <label htmlFor="report-to">
              结束日期
              <Input
                id="report-to"
                type="date"
                value={range.to}
                min={range.from || undefined}
                onChange={(e) => {
                  setRange({ ...range, to: e.target.value });
                  setMonth('');
                  setPlaying(false);
                }}
              />
            </label>
          </div>
        )}
      </section>
      <aside className="screen-rail rail-left" inert={navigating}>
        <section className="hud-panel overview-hud">
          <PanelTitle title="监测信息与结果总览" code="01 / OVERVIEW" />
          <div className="hud-metrics">
            {[
              ['有效试剂', number(m?.tested), '个'],
              ['阳性试剂', number(m?.positive), '个'],
              ['有效提交', number(m?.submissions), '批'],
              ['检出病原体', number(m?.pathogens), '种'],
            ].map(([label, value, unit], i) => (
              <div key={label} className={'hud-metric metric-tone-' + i}>
                <span>{label}</span>
                <strong>
                  {value}
                  <small>{unit}</small>
                </strong>
              </div>
            ))}
          </div>
          <div className="rate-readout">
            <div
              className="rate-ring"
              style={
                {
                  '--rate': `${(m?.rate || 0) * 360}deg`,
                } as React.CSSProperties
              }
            >
              <span>{percent(m?.rate)}</span>
            </div>
            <div>
              <strong>{pathogen ? '所选病原体阳性率' : '试剂阳性率'}</strong>
              <p>对照数据已剔除</p>
              <small>任一病原体阳性计为阳性试剂</small>
            </div>
          </div>
        </section>
        <section className="hud-panel ranking-hud">
          <PanelTitle title="病原体检出排行" code="02 / DETECTION" />
          <div className="hud-table-header">
            <span>病原体</span>
            <span>阳性试剂</span>
          </div>
          <div className="rank-list">
            {data?.ranking.length ? (
              data.ranking.map((r, i) => (
                <button
                  className={
                    'hud-rank ' + (pathogen === r.code ? 'is-selected' : '')
                  }
                  key={r.code}
                  onClick={() => setPathogen(pathogen === r.code ? '' : r.code)}
                >
                  <span className="rank-code">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <div className="hud-rank-title">
                      <span>{r.name}</span>
                      <b>{number(r.positive)}</b>
                    </div>
                    <div className="hud-rank-bar">
                      <i
                        style={{
                          width: `${(r.positive / Math.max(1, data.ranking[0].positive)) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <p className="hud-empty">
                {loading ? '正在同步监测结果…' : '当前范围暂无检出记录'}
              </p>
            )}
          </div>
          <p className="hud-note">
            {data?.missingPanel
              ? '部分阴性记录未注明面板，单病原体阳性率不作推算。'
              : '点击病原体，联动查看空间分布。'}
          </p>
        </section>
      </aside>
      <aside className="screen-rail rail-right">
        <section className="hud-panel temporal-hud">
          <PanelTitle title="病原体时空分布" code="03 / TEMPORAL" />
          <div className="temporal-chart">
            {chartData?.ranking.length ? (
              <Chart
                option={heat}
                height="100%"
                label="病原体逐月阳性试剂数热力图"
              />
            ) : (
              <p className="hud-empty">暂无病原体时间数据</p>
            )}
          </div>
          <p className="hud-note">颜色深浅表示检出数量 · 单位：份</p>
        </section>
        <section className="hud-panel trend-hud">
          <PanelTitle title="检测量与阳性趋势" code="04 / TREND" />
          {chartData?.trend.length ? (
            <Chart
              option={trend}
              height={160}
              label="逐月检测量与阳性率趋势图"
            />
          ) : (
            <p className="hud-empty">暂无趋势数据</p>
          )}
          <div className="hud-chart-key">
            <i />
            有效检测
            <i />
            试剂阳性率
          </div>
        </section>
      </aside>
      <div className="map-frame-caption">
        <span>
          <Radio size={15} />
          {playing && months.length > 1 ? '时序扫描中' : '区域自动巡览'}
        </span>
        <strong>
          {region.name} ·{' '}
          {
            (
              {
                country: '省级',
                province: '下级行政区',
                city: '区县',
                county: '区县',
              } as Record<string, string>
            )[region.level]
          }
          监测
        </strong>
        <p>
          {mapMode === '3d'
            ? '板块升降与变色，呈现检测结果变化'
            : '区域颜色变化，呈现检测结果变化'}
        </p>
      </div>
      {error && (
        <div className="screen-error" role="alert">
          {error}
          <Button variant="outline" onClick={() => setRefresh((v) => v + 1)}>
            重试
          </Button>
        </div>
      )}
      <footer className="screen-time" inert={navigating}>
        <div className="time-heading">
          <span>时空演变 / TEMPORAL SEQUENCE</span>
          <div>
            <strong>
              {month || (range.from || range.to ? '自定义时段' : '全时段')}
            </strong>
            <small>
              {playing && months.length > 1 ? '每 5 秒推进一月' : '报告时间'}
            </small>
          </div>
        </div>
        <div className="time-playback">
          <Button
            variant="secondary"
            size="icon"
            disabled={months.length < 2}
            aria-label={playing ? '暂停月份推进' : '播放月份推进'}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <button
            className={
              'all-time ' + (!month && !range.from && !range.to ? 'active' : '')
            }
            onClick={() => selectMonth('')}
          >
            累计
          </button>
          <div className="time-months">
            {months.length ? (
              months.map((mo) => (
                <button
                  key={mo}
                  className={month === mo ? 'active' : ''}
                  onClick={() => selectMonth(mo)}
                >
                  <span>{mo.slice(0, 4)}</span>
                  <strong>{Number(mo.slice(5))}月</strong>
                  <i>{month === mo && playing && <b key={mo + refresh} />}</i>
                </button>
              ))
            ) : (
              <span className="time-empty">当前数据集暂无报告月份</span>
            )}
          </div>
        </div>
      </footer>
    </main>
  );
}
function PanelTitle({ title, code }: { title: string; code: string }) {
  return (
    <div className="hud-title">
      <span />
      <h2>{title}</h2>
      <small>{code}</small>
    </div>
  );
}
