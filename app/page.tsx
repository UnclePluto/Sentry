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
import { PathogenPicker } from '@/components/pathogen-picker';
import {
  dashboardQuery,
  normalizePathogens,
  pathogenScope,
} from '@/lib/dashboard-query';
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
    [pathogens, setPathogens] = useState<string[]>([]),
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
  const requestIdentity = useRef('');
  const [navigating, setNavigating] = useState(false);
  const initialized = useRef(false);
  const region = path[path.length - 1];
  const selectedPathogens = useMemo(
    () => normalizePathogens(pathogens),
    [pathogens],
  );
  const pathogenKey = pathogenScope(selectedPathogens);
  const filterIdentity = `${demo}|${range.from}|${range.to}|${pathogenKey}`;
  useEffect(() => {
    requestIdentity.current = filterIdentity;
  }, [filterIdentity]);
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
        dashboardQuery({
          demo,
          region: region.code,
          pathogens: selectedPathogens,
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
  }, [demo, region.code, selectedPathogens, refresh]);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError('');
    api<DashboardData>(
      '/dashboard?' +
        dashboardQuery({
          demo,
          ...range,
          region: region.code,
          pathogens: selectedPathogens,
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
  }, [demo, range, region.code, selectedPathogens, refresh]);
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
            pathogens: selectedPathogens,
            ...range,
            metrics: data?.metrics || null,
          }),
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, [demo, data, region, range, selectedPathogens]);
  useEffect(() => {
    const t = setInterval(() => setRefresh((v) => v + 1), 20000);
    return () => clearInterval(t);
  }, []);
  const chartData = overview;
  const heat = useMemo(() => {
    const ranks = chartData?.ranking || [];
    const ms = months;
    const values = ranks.flatMap((r, y) =>
      ms.map((month, x) => {
        const item = chartData?.heatmap.find(
          (value) => value.code === r.code && value.month === month,
        );
        return [x, y, item && item.tested > 0 ? item.count : null];
      }),
    );
    return {
      tooltip: {
        formatter: (point: { value: [number, number, number | null] }) => {
          const count = point.value[2];
          return `${safe(ranks[point.value[1]]?.name || '')}<br/>${ms[point.value[0]]} · ${count == null ? '未检测' : `${count} 份阳性样本`}`;
        },
      },
      grid: { left: 112, right: ranks.length > 8 ? 28 : 8, top: 9, bottom: 24 },
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
        max: Math.max(
          1,
          ...values.map((value) =>
            typeof value[2] === 'number' ? value[2] : 0,
          ),
        ),
        inRange: {
          color: ['#102035', '#174b70', '#317c99', '#9561c7', '#ed9fe6'],
        },
      },
      dataZoom:
        ranks.length > 8
          ? [
              {
                type: 'inside',
                yAxisIndex: 0,
                startValue: 0,
                endValue: 7,
              },
              {
                type: 'slider',
                yAxisIndex: 0,
                right: 1,
                width: 10,
                startValue: 0,
                endValue: 7,
                showDetail: false,
              },
            ]
          : [],
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
  }, [chartData, months]);
  async function navigate(nextPath: Region[]) {
    if (navigationRequest.current || nextPath.at(-1)?.code === region.code)
      return;
    const controller = new AbortController();
    const identity = requestIdentity.current;
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
            dashboardQuery({
              demo,
              ...range,
              region: target.code,
              pathogens: selectedPathogens,
            }),
          { signal: controller.signal },
        ),
      ]);
      if (
        !controller.signal.aborted &&
        requestIdentity.current === identity &&
        navigationRequest.current === controller
      )
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
  useEffect(() => {
    navigationRequest.current?.abort();
    navigationRequest.current = null;
    setNavigation(null);
    setNavigating(false);
  }, [filterIdentity]);
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
          motionScope={`${demo}-${pathogenKey}`}
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
          <PathogenPicker
            value={pathogens}
            onChange={setPathogens}
            options={overview?.pathogenOptions || []}
            disabled={navigating}
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
              setPathogens([]);
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
              ['样本数', number(m?.samples), '份'],
              ['阳性样本数', number(m?.positive), '份'],
              ['监测区域', number(m?.regions), '个'],
              ['检出病原体总数', number(m?.pathogens), '种'],
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
              <strong>样本阳性率</strong>
              <p>
                {pathogens.length
                  ? `所选病原体未检出 ${number(m?.notDetected)} 份`
                  : '任一病原体阳性样本数 / 样本总数'}
              </p>
              <small>
                {m?.excludedNoSelectedTest
                  ? `${number(m.excludedNoSelectedTest)} 份样本未检测任何所选病原体，未计入统计`
                  : pathogens.length
                    ? '所选病原体任一阳性样本数 / 检测过任一所选病原体的样本数'
                    : '整份 N 样本计为阴性样本'}
              </small>
            </div>
          </div>
        </section>
        <section className="hud-panel ranking-hud">
          <PanelTitle title="病原体检出排行" code="02 / DETECTION" />
          <div className="hud-table-header">
            <span>病原体</span>
            <span>阳性样本数</span>
          </div>
          <div className="rank-list">
            {data?.ranking.length ? (
              data.ranking.map((r, i) => (
                <button
                  className={
                    'hud-rank ' +
                    (pathogens.includes(r.code) ? 'is-selected' : '')
                  }
                  key={r.code}
                  onClick={() =>
                    setPathogens((current) =>
                      normalizePathogens(
                        current.includes(r.code)
                          ? current.filter((value) => value !== r.code)
                          : [...current, r.code],
                      ),
                    )
                  }
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
            {m?.excludedNoSelectedTest
              ? `${number(m.excludedNoSelectedTest)} 份样本未检测任何所选病原体，未计入统计。`
              : '点击病原体可叠加选择，联动查看空间分布。'}
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
                label="病原体逐月阳性样本数热力图"
              />
            ) : (
              <p className="hud-empty">暂无病原体时间数据</p>
            )}
          </div>
          <p className="hud-note">
            全部报告月份 · 颜色深浅表示阳性样本数 · 单位：份；空白表示未检测
          </p>
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
