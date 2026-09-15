'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, PolygonLayer, PathLayer } from '@deck.gl/layers';
import { WebMercatorViewport } from '@deck.gl/core';
import { useMapAppearance } from './use-map-appearance';
import { MapTransition } from './map-transition';
import type { MapJourney } from './map-transition';
import { boxesOverlap, coveredBySurface } from '@/lib/map-labels';
import type { ScreenPoint, ScreenSurface } from '@/lib/map-labels';
import type { PickingInfo } from '@deck.gl/core';
import {
  LockKeyhole,
  UnlockKeyhole,
  Plus,
  Minus,
  Focus,
  MapPin,
  ScanLine,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, number, percent } from '@/lib/api';
import type {
  GeoData,
  GeoFeature,
  GeoProperties,
  RegionGroups,
  RegionStats,
} from '@/lib/models';
import {
  FIXED_BEARING,
  FIXED_PITCH,
  viewportPolicy,
  changedRegions,
  plateLift,
  regionColor,
} from '@/lib/map-motion';
export type Region = {
  code: string;
  name: string;
  level: string;
  center?: number[];
};
type Plate = { feature: GeoFeature; rings: number[][][]; code: string };
type Border = { code: string; points: number[][] };
const shortName = (s: string) =>
  s.replace(/(壮族|回族|维吾尔)?自治区$|特别行政区$|省$|市$/g, '');
export default function MapView({
  region,
  regions,
  onDrill,
  motionScope = '',
  mapMode,
  onModeChange,
  preparedGeo,
  navigation,
  arrival,
  onTransitionEnd,
  refreshToken,
}: {
  region: Region;
  regions?: RegionGroups;
  onDrill: (r: Region) => void;
  motionScope?: string;
  mapMode: '2d' | '3d';
  onModeChange: (mode: '2d' | '3d') => void;
  preparedGeo?: GeoData | null;
  navigation?: MapJourney | null;
  arrival?: MapJourney | null;
  onTransitionEnd: () => void;
  refreshToken: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<RegionStats[] | null>(null);
  const scene = useRef<HTMLDivElement>(null);
  const [entering, setEntering] = useState(Boolean(arrival));
  const [measured, setMeasured] = useState(false);
  const lastReveal = useRef(refreshToken);
  const [geo, setGeo] = useState<GeoData | null>(preparedGeo || null),
    [error, setError] = useState(''),
    [zoomOffset, setZoomOffset] = useState(0),
    [pan, setPan] = useState({ longitude: 0, latitude: 0 }),
    [locked, setLocked] = useState(true),
    [webgl, setWebgl] = useState(true),
    [size, setSize] = useState({ width: 1440, height: 900 }),
    [scan, setScan] = useState(0),
    [hovered, setHovered] = useState<string | null>(null),
    [changed, setChanged] = useState<string[]>([]),
    [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!root.current) return;
    const ro = new ResizeObserver(([e]) => {
      setSize({ width: e.contentRect.width, height: e.contentRect.height });
      setMeasured(true);
    });
    ro.observe(root.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (preparedGeo) {
      setGeo(preparedGeo);
      return;
    }
    const c = new AbortController();
    setZoomOffset(0);
    setError('');
    setGeo(null);
    previous.current = null;
    api<GeoData>('/geo?code=' + region.code, { signal: c.signal })
      .then(setGeo)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => c.abort();
  }, [region.code, preparedGeo]);
  const direct =
    region.level === 'province' &&
    geo?.features.every((f) => f.properties.level === 'district');
  const level =
    region.level === 'country'
      ? 'province'
      : region.level === 'province'
        ? direct
          ? 'county'
          : 'city'
        : 'county';
  const data = useMemo(() => regions?.[level] || [], [regions, level]);
  useEffect(() => {
    previous.current = null;
    setChanged([]);
  }, [motionScope]);
  useEffect(() => {
    if (!regions) return;
    const codes = changedRegions(previous.current, data);
    previous.current = data;
    setChanged(codes);
    if (!codes.length) return;
    const t = setTimeout(() => setChanged([]), 4200);
    return () => clearTimeout(t);
  }, [data, regions]);
  const allFeatures = useMemo(() => {
    const polygons =
      geo?.features.filter((f) =>
        ['Polygon', 'MultiPolygon'].includes(f.geometry.type),
      ) || [];
    if (region.level !== 'country') return polygons;
    // 全国展示聚焦大陆、海南岛与台湾岛；附属海域不参与绘制或自动取景。
    return polygons
      .filter((f) => f.properties.name)
      .map((feature) => {
        if (
          String(feature.properties.adcode) !== '460000' ||
          feature.geometry.type !== 'MultiPolygon'
        )
          return feature;
        return {
          ...feature,
          geometry: {
            ...feature.geometry,
            coordinates: feature.geometry.coordinates.filter((polygon) =>
              polygon[0].some((point) => point[1] >= 18),
            ),
          },
        };
      });
  }, [geo, region.level]);
  const features = useMemo(
    () => allFeatures.filter((f) => f.properties.adcode),
    [allFeatures],
  );
  const lookup = useMemo(() => new Map(data.map((r) => [r.code, r])), [data]);
  const scanCodes = useMemo(() => {
    return features
      .filter((f) => lookup.has(String(f.properties.adcode)))
      .map((f) => String(f.properties.adcode));
  }, [features, lookup]);
  useEffect(() => {
    if (reduced || scanCodes.length < 2 || navigation || entering) return;
    const t = setInterval(
      () => setScan((v) => (v + 1) % scanCodes.length),
      3400,
    );
    return () => clearInterval(t);
  }, [reduced, scanCodes.length, navigation, entering]);
  const active =
    hovered || scanCodes[scan % Math.max(1, scanCodes.length)] || '';
  const is3d = webgl && mapMode === '3d';
  const base = !is3d
    ? 0
    : region.level === 'country'
      ? 245000
      : region.level === 'province'
        ? 43000
        : region.level === 'city'
          ? 10000
          : 1800;
  const thickness = base * 0.28;
  const targets = useMemo(
    () =>
      regions
        ? Object.fromEntries(
            allFeatures.map((f) => {
              const code = String(f.properties.adcode);
              const rate = lookup.get(code)?.rate ?? null;
              return [
                code,
                { height: plateLift(base, rate), color: regionColor(rate) },
              ];
            }),
          )
        : {},
    [allFeatures, base, lookup, regions],
  );
  const appearance = useMapAppearance(targets, reduced);
  const elevation = (code: string) =>
    is3d ? (appearance[code]?.height ?? 0) : 0;
  const fillColor = (code: string) =>
    appearance[code]?.color ?? regionColor(lookup.get(code)?.rate ?? null);
  const padding = useMemo(() => {
    const rail =
      size.width <= 1000
        ? 22
        : Math.min(
            342,
            Math.max(size.width <= 1250 ? 255 : 260, size.width * 0.2),
          ) + 52;
    return {
      left: rail,
      right: rail,
      top: size.width <= 1000 ? 235 : 240,
      bottom: size.width <= 1000 ? 170 : 200,
    };
  }, [size.width]);
  const initial = useMemo(() => {
    const coordinates = allFeatures.flatMap((f) =>
      (f.geometry.type === 'MultiPolygon'
        ? f.geometry.coordinates
        : [f.geometry.coordinates]
      ).flat(2),
    );
    if (!coordinates.length) return { longitude: 104.5, latitude: 33, zoom: 3 };
    let minX = 180,
      minY = 90,
      maxX = -180,
      maxY = -90;
    for (const [x, y] of coordinates) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const frame = new WebMercatorViewport({
      width: Math.max(1, size.width),
      height: Math.max(1, size.height),
    }).fitBounds(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { padding, minExtent: 0.025, maxZoom: 11 },
    );
    return {
      longitude: frame.longitude,
      latitude: frame.latitude,
      zoom: frame.zoom + 0.16,
    };
  }, [allFeatures, size, padding]);
  const view = {
    ...initial,
    longitude: initial.longitude + pan.longitude,
    latitude: Math.max(-80, Math.min(80, initial.latitude + pan.latitude)),
    zoom: Math.max(1, Math.min(13, initial.zoom + zoomOffset)),
    pitch: is3d ? FIXED_PITCH : 0,
    bearing: is3d ? FIXED_BEARING : 0,
    minZoom: 1,
    maxZoom: 13,
  };
  const viewport = new WebMercatorViewport({
    ...view,
    width: size.width,
    height: size.height,
  });
  const plates = useMemo(
    () =>
      allFeatures.flatMap((feature) =>
        (feature.geometry.type === 'MultiPolygon'
          ? feature.geometry.coordinates
          : [feature.geometry.coordinates]
        ).map((rings) => ({
          feature,
          rings,
          code: String(feature.properties.adcode),
        })),
      ),
    [allFeatures],
  );
  const borders = useMemo(
    () =>
      plates.flatMap((p) =>
        p.rings.map((points) => ({ code: p.code, points })),
      ),
    [plates],
  );
  const choose = (feature: GeoFeature) => {
    if (
      region.level === 'county' ||
      !feature.properties.adcode ||
      String(feature.properties.adcode) === region.code
    )
      return;
    const p = feature.properties;
    onDrill({
      code: String(p.adcode),
      name: p.name,
      level: p.level === 'district' ? 'county' : p.level,
      center: p.centroid || p.center,
    });
  };
  const activeStats = lookup.get(active);
  const activeName =
    activeStats?.name ||
    features.find((f) => String(f.properties.adcode) === active)?.properties
      .name;
  const duration = reduced || !is3d ? 0 : 1250;
  const layerTriggers = [data, active, changed, base, appearance];
  const layers = [
    new GeoJsonLayer<GeoProperties>({
      id: 'map-foundation',
      visible: is3d,
      data: { type: 'FeatureCollection', features: allFeatures },
      filled: true,
      stroked: true,
      getFillColor: [8, 24, 45, 240],
      getLineColor: [29, 69, 96, 200],
      lineWidthMinPixels: 0.5,
      pickable: false,
    }),
    new GeoJsonLayer<GeoProperties>({
      id: 'flat-region-fills',
      visible: !is3d,
      data: { type: 'FeatureCollection', features: allFeatures },
      filled: true,
      stroked: true,
      extruded: false,
      pickable: true,
      // 各层级直接描绘当前行政区 GeoJSON 边界，不依赖 3D 高程轮廓。
      getLineColor: (feature) => {
        const code = String(feature.properties.adcode);
        return code === active
          ? [153, 242, 255, 255]
          : changed.includes(code)
            ? [218, 166, 255, 255]
            : [104, 181, 211, 235];
      },
      getLineWidth: (feature) =>
        String(feature.properties.adcode) === active ? 1.35 : 0.85,
      lineWidthUnits: 'pixels',
      lineWidthMinPixels: 0.75,
      lineWidthMaxPixels: 1.5,
      lineJointRounded: true,
      getFillColor: (feature) => {
        const code = String(feature.properties.adcode);
        return fillColor(code);
      },
      updateTriggers: {
        getFillColor: [appearance, data],
        getLineColor: [active, changed],
        getLineWidth: [active],
      },
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
      onClick: ({ object }) => object && choose(object as GeoFeature),
      onHover: ({ object }) =>
        setHovered(object ? String(object.properties.adcode) : null),
    }),
    new PolygonLayer<Plate>({
      id: 'floating-region-plates',
      visible: is3d,
      data: plates,
      pickable: true,
      extruded: is3d,
      wireframe: false,
      getPolygon: (p) =>
        p.rings.map((ring) => ring.map(([x, y]) => [x, y, elevation(p.code)])),
      getElevation: thickness,
      getFillColor: (p) => fillColor(p.code),
      material: {
        ambient: 0.8,
        diffuse: 0.45,
        shininess: 48,
        specularColor: [30, 100, 180],
      },
      updateTriggers: {
        getPolygon: layerTriggers,
        getFillColor: layerTriggers,
      },
      onClick: ({ object }) => object && choose(object.feature),
      onHover: ({ object }) => setHovered(object?.code || null),
    }),
    new PathLayer<Border>({
      id: 'province-edge-glow',
      visible: is3d,
      data: borders,
      getPath: (b) =>
        b.points.map(
          ([x, y]) =>
            [x, y, elevation(b.code) + thickness + base * 0.012] as [
              number,
              number,
              number,
            ],
        ),
      getColor: (b) =>
        b.code === active
          ? [61, 232, 255, 90]
          : changed.includes(b.code)
            ? [206, 132, 255, 75]
            : [23, 149, 220, 30],
      getWidth: 2,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      jointRounded: true,
      capRounded: true,
      transitions: { getColor: duration },
      updateTriggers: { getPath: layerTriggers, getColor: layerTriggers },
      parameters: { depthCompare: 'always' },
    }),
    new PathLayer<Border>({
      id: 'province-division-lines',
      visible: is3d,
      data: borders,
      getPath: (b) =>
        b.points.map(
          ([x, y]) =>
            [x, y, elevation(b.code) + thickness + base * 0.018] as [
              number,
              number,
              number,
            ],
        ),
      getColor: (b) =>
        b.code === active
          ? [131, 245, 255, 255]
          : changed.includes(b.code)
            ? [218, 154, 255, 255]
            : [46, 157, 204, 240],
      getWidth: 0.65,
      widthUnits: 'pixels',
      widthMinPixels: 0.5,
      jointRounded: true,
      capRounded: true,
      transitions: { getColor: duration },
      updateTriggers: { getPath: layerTriggers, getColor: layerTriggers },
      parameters: { depthCompare: 'always' },
    }),
  ];
  const surfaces = useMemo<ScreenSurface[]>(() => {
    const projection = new WebMercatorViewport({
      ...view,
      width: size.width,
      height: size.height,
    });
    return plates.map((plate) => {
      const z = elevation(plate.code) + thickness;
      const rings = plate.rings.map((ring) =>
        ring.map(
          ([x, y]) => projection.project([x, y, z]).slice(0, 2) as ScreenPoint,
        ),
      );
      const outer = rings[0];
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const [x, y] of outer) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      return {
        code: plate.code,
        elevation: z,
        rings,
        bounds: {
          x: (minX + maxX) / 2,
          y: (minY + maxY) / 2,
          width: maxX - minX,
          height: maxY - minY,
        },
      };
    });
  }, [
    plates,
    appearance,
    is3d,
    active,
    changed,
    data,
    base,
    thickness,
    view.longitude,
    view.latitude,
    view.zoom,
    view.pitch,
    view.bearing,
    size.width,
    size.height,
  ]);
  const placements: {
    code: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    hidden: boolean;
    feature?: GeoFeature;
  }[] = [];
  const labelData = features
    .filter((f) => f.properties.center || f.properties.centroid)
    .map((f) => ({
      code: String(f.properties.adcode),
      name: shortName(f.properties.name),
      position: f.properties.centroid || f.properties.center,
      z: elevation(String(f.properties.adcode)) + thickness + base * 0.055,
      feature: f,
    }));
  labelData.sort(
    (a, b) =>
      Number(b.code === active) - Number(a.code === active) ||
      Number((lookup.get(b.code)?.positive || 0) > 0) -
        Number((lookup.get(a.code)?.positive || 0) > 0) ||
      Number(lookup.has(b.code)) - Number(lookup.has(a.code)),
  );
  const safeLeft = padding.left - 12,
    safeRight = size.width - padding.right + 12;
  for (const item of labelData) {
    const [x, y] = viewport.project([...item.position, item.z]);
    const width = Math.min(138, Math.max(44, item.name.length * 14 + 12));
    const height = item.name.length > 8 ? 44 : 26;
    const box = { x, y, width, height };
    const outside =
      x - width / 2 < safeLeft ||
      x + width / 2 > safeRight ||
      y - height / 2 < 115 ||
      y + height / 2 > size.height - 145;
    const overlapsLabel = placements.some(
      (p) => !p.hidden && boxesOverlap(p, box, 3),
    );
    const noCases = !lookup.get(item.code)?.positive;
    const covered =
      is3d &&
      noCases &&
      item.code !== active &&
      surfaces.some(
        (surface) =>
          surface.code !== item.code &&
          surface.elevation > item.z &&
          coveredBySurface(box, surface),
      );
    placements.push({
      code: item.code,
      name: item.name,
      ...box,
      hidden: outside || overlapsLabel || covered,
      feature: item.feature,
    });
  }
  const activePosition = labelData.find((p) => p.code === active);
  const scanPosition = activePosition
    ? viewport.project([...activePosition.position, activePosition.z])
    : null;
  useEffect(() => {
    if (
      !geo ||
      !scene.current ||
      navigation ||
      (arrival && lastReveal.current === refreshToken)
    )
      return;
    const refreshOnly = lastReveal.current !== refreshToken;
    lastReveal.current = refreshToken;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const animation = scene.current.animate(
      [
        { opacity: refreshOnly ? 0.35 : 0, filter: 'blur(2px)' },
        { opacity: 1, filter: 'blur(0px)' },
      ],
      { duration: 650, easing: 'ease-out' },
    );
    return () => animation.cancel();
  }, [geo, refreshToken]);
  const transitioning = Boolean(navigation || entering);
  return (
    <div
      ref={root}
      className={
        'map-stage cyber-map-stage ' +
        (locked ? 'is-locked ' : '') +
        (transitioning ? 'is-transitioning' : '')
      }
      aria-busy={transitioning}
    >
      <div
        ref={scene}
        className="map-scene"
        style={{ visibility: transitioning ? 'hidden' : 'visible' }}
      >
        {geo && webgl && (
          <DeckGL
            viewState={view}
            onViewStateChange={({ viewState }) => {
              if (locked || transitioning || !('longitude' in viewState))
                return;
              setZoomOffset(
                Math.max(-0.65, Math.min(3, viewState.zoom - initial.zoom)),
              );
              setPan({
                longitude:
                  Math.max(-180, Math.min(180, viewState.longitude)) -
                  initial.longitude,
                latitude:
                  Math.max(-80, Math.min(80, viewState.latitude)) -
                  initial.latitude,
              });
            }}
            controller={viewportPolicy(locked || transitioning)}
            getCursor={({ isDragging, isHovering }) =>
              locked
                ? isHovering
                  ? 'pointer'
                  : 'default'
                : isDragging
                  ? 'grabbing'
                  : 'grab'
            }
            layers={layers}
            onError={() => setWebgl(false)}
            getTooltip={({ object }: PickingInfo<Plate | GeoFeature>) => {
              if (!object) return null;
              const code =
                'properties' in object
                  ? String(object.properties.adcode)
                  : object.code;
              const d = lookup.get(code);
              const name =
                'properties' in object
                  ? object.properties.name
                  : object.feature.properties.name;
              return {
                text: `${name}\n${d ? `有效检测 ${number(d.tested)} · 阳性 ${number(d.positive)}\n阳性率 ${percent(d.rate)}` : '当前时段暂无检测数据'}`,
                style: {
                  background: '#0a1931',
                  border: '1px solid #456e99',
                  color: '#d4efff',
                  fontSize: '14px',
                  padding: '12px',
                  borderRadius: '2px',
                  maxWidth: '300px',
                },
              };
            }}
          />
        )}
        {geo && !webgl && (
          <FallbackMap
            features={features}
            data={data}
            zoomOffset={zoomOffset}
            locked={locked || transitioning}
            pan={pan}
            onPan={setPan}
            onZoom={setZoomOffset}
            onDrill={choose}
          />
        )}
        {geo && webgl && (
          <div className="region-label-layer">
            {placements.map((p) => (
              <button
                key={p.code}
                className={
                  'region-label ' +
                  (p.hidden ? 'is-hidden ' : '') +
                  (p.code === active ? 'active ' : '') +
                  (changed.includes(p.code) ? 'changed' : '')
                }
                style={
                  {
                    left: p.x,
                    top: p.y,
                    maxWidth: p.width,
                    '--label-reveal-delay': `${duration}ms`,
                    '--label-move-duration': '0ms',
                  } as React.CSSProperties
                }
                aria-hidden={p.hidden}
                tabIndex={p.hidden ? -1 : 0}
                title={p.feature?.properties.name || p.name}
                aria-label={'查看' + (p.feature?.properties.name || p.name)}
                onClick={() => p.feature && choose(p.feature)}
                onMouseEnter={() => setHovered(p.code)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(p.code)}
                onBlur={() => setHovered(null)}
              >
                {p.name}
              </button>
            ))}
            {scanPosition && !reduced && (
              <div
                key={active}
                className="region-scan-ring"
                aria-hidden="true"
                style={{ left: scanPosition[0], top: scanPosition[1] }}
              >
                <i />
                <i />
                <b />
              </div>
            )}
          </div>
        )}
      </div>
      {geo && measured && transitioning && (
        <MapTransition
          key={navigation ? 'exit' : 'enter'}
          journey={navigation || arrival!}
          phase={navigation ? 'exit' : 'enter'}
          surfaces={surfaces}
          width={size.width}
          height={size.height}
          color={(code) => `rgba(${fillColor(code).slice(0, 3).join(',')},1)`}
          onComplete={navigation ? onTransitionEnd : () => setEntering(false)}
        />
      )}
      <div className="fixed-map-controls" inert={transitioning}>
        <div className="map-mode-switch" role="group" aria-label="地图显示模式">
          {(['2d', '3d'] as const).map((mode) => (
            <Button
              key={mode}
              variant="secondary"
              size="icon"
              aria-label={`切换到 ${mode.toUpperCase()} 地图`}
              aria-pressed={(is3d ? '3d' : '2d') === mode}
              disabled={mode === '3d' && !webgl}
              onClick={() => {
                onModeChange(mode);
                setZoomOffset(0);
                setPan({ longitude: 0, latitude: 0 });
              }}
            >
              {mode.toUpperCase()}
            </Button>
          ))}
        </div>
        <Button
          variant="secondary"
          size="icon"
          title="放大地图"
          aria-label="放大地图"
          disabled={zoomOffset >= 3}
          onClick={() => setZoomOffset((v) => Math.min(3, v + 0.35))}
        >
          <Plus />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          title="缩小地图"
          aria-label="缩小地图"
          disabled={zoomOffset <= -0.65}
          onClick={() => setZoomOffset((v) => Math.max(-0.65, v - 0.35))}
        >
          <Minus />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          title="恢复初始视图"
          aria-label="恢复初始视图"
          onClick={() => {
            setZoomOffset(0);
            setPan({ longitude: 0, latitude: 0 });
          }}
        >
          <Focus />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className={locked ? 'lock-active' : ''}
          aria-label={locked ? '解锁地图拖拽与缩放' : '锁定地图拖拽与缩放'}
          aria-pressed={locked}
          title={
            locked
              ? '已锁定：仅按钮缩放与点击下钻'
              : '已解锁：可拖拽平移与滚轮缩放，倾斜角度保持固定'
          }
          onClick={() => setLocked(!locked)}
        >
          {locked ? <LockKeyhole /> : <UnlockKeyhole />}
        </Button>
        <span>{locked ? '视图锁定' : '拖拽开启'}</span>
      </div>
      <div className="floating-map-legend">
        <span>{is3d ? '颜色 / 高度：试剂阳性率' : '试剂阳性率'}</span>
        <div>
          <i style={{ background: '#0c2e4d' }} />
          无数据
          <i style={{ background: '#125476' }} />
          &lt;25%
          <i style={{ background: '#227591' }} />
          25–50%
          <i style={{ background: '#5d4ea4' }} />
          50–75%
          <i style={{ background: '#98449e' }} />
          ≥75%
        </div>
        <small>紫色边缘：时段数据变化 · 青色脉冲：区域轮巡</small>
      </div>
      {activeName && activeStats && (
        <div className="scan-readout" key={active}>
          <div>
            <ScanLine size={14} />
            <span>{hovered ? '区域详情' : '区域巡览'}</span>
            <em>
              {String((scan % Math.max(1, scanCodes.length)) + 1).padStart(
                2,
                '0',
              )}{' '}
              / {String(scanCodes.length).padStart(2, '0')}
            </em>
          </div>
          <h3>{activeName}</h3>
          <p>
            <span>
              有效检测 <b>{number(activeStats.tested)}</b>
            </span>
            <span>
              阳性率 <b>{percent(activeStats.rate)}</b>
            </span>
          </p>
        </div>
      )}
      {error && (
        <div className="map-message" role="alert">
          {error}
        </div>
      )}
      {!geo && !error && (
        <div className="map-message">正在构建区域监测视图…</div>
      )}
      {geo && !data.length && (
        <div className="no-map-data">
          <MapPin size={15} />
          当前区域、时段暂无监测数据
        </div>
      )}
    </div>
  );
}
/* oxlint-disable jsx-a11y/prefer-tag-over-role -- SVG 区域使用按钮语义及键盘事件。 */
function FallbackMap({
  features,
  data,
  zoomOffset,
  locked,
  pan,
  onPan,
  onZoom,
  onDrill,
}: {
  features: GeoFeature[];
  data: RegionStats[];
  zoomOffset: number;
  locked: boolean;
  pan: { longitude: number; latitude: number };
  onPan: (value: { longitude: number; latitude: number }) => void;
  onZoom: (value: number) => void;
  onDrill: (f: GeoFeature) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    matrix: DOMMatrix;
    longitude: number;
    latitude: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const node = svg.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (locked) return;
      event.preventDefault();
      onZoom(
        Math.max(
          -0.65,
          Math.min(3, zoomOffset + (event.deltaY < 0 ? 0.15 : -0.15)),
        ),
      );
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [locked, zoomOffset, onZoom]);
  const coordinates = features.flatMap((f) =>
    (f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates]
    ).flat(2),
  );
  if (!coordinates.length) return null;
  let minX = 180,
    minY = 90,
    maxX = -180,
    maxY = -90;
  for (const [x, y] of coordinates) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return (
    <div className="cyber-fallback">
      <span>当前设备使用二维区域视图</span>
      <svg
        ref={svg}
        style={{
          cursor: locked ? 'default' : dragging ? 'grabbing' : 'grab',
          touchAction: locked ? 'auto' : 'none',
        }}
        viewBox={`${400 - 400 / 2 ** zoomOffset + (pan.longitude / (maxX - minX)) * 740} ${250 - 250 / 2 ** zoomOffset - (pan.latitude / (maxY - minY)) * 440} ${800 / 2 ** zoomOffset} ${500 / 2 ** zoomOffset}`}
        onPointerDown={(event) => {
          suppressClick.current = false;
          if (locked || event.button !== 0) return;
          const matrix = event.currentTarget.getScreenCTM()?.inverse();
          if (!matrix) return;
          const point = new DOMPoint(
            event.clientX,
            event.clientY,
          ).matrixTransform(matrix);
          drag.current = { x: point.x, y: point.y, matrix, ...pan };
          (event.target as Element).setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current || locked) return;
          const start = drag.current,
            point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
              start.matrix,
            );
          const dx = point.x - start.x,
            dy = point.y - start.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) suppressClick.current = true;
          if (suppressClick.current)
            onPan({
              longitude: start.longitude - (dx * (maxX - minX)) / 740,
              latitude: start.latitude + (dy * (maxY - minY)) / 440,
            });
        }}
        onPointerUp={(event) => {
          drag.current = null;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        {features.map((f) => (
          <path
            key={f.properties.adcode}
            role="button"
            tabIndex={0}
            aria-label={'查看' + f.properties.name}
            onClick={() => {
              if (!suppressClick.current) onDrill(f);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onDrill(f);
              }
            }}
            fill={`rgb(${regionColor(
              data.find((d) => d.code === String(f.properties.adcode))?.rate ??
                null,
            )
              .slice(0, 3)
              .join(',')})`}
            stroke="#5edcff"
            strokeWidth="0.85"
            vectorEffect="non-scaling-stroke"
            d={(f.geometry.type === 'MultiPolygon'
              ? f.geometry.coordinates
              : [f.geometry.coordinates]
            )
              .map((poly) =>
                poly
                  .map(
                    (ring) =>
                      ring
                        .map(
                          ([x, y], i) =>
                            `${i ? 'L' : 'M'}${30 + ((x - minX) / (maxX - minX)) * 740},${470 - ((y - minY) / (maxY - minY)) * 440}`,
                        )
                        .join(' ') + 'Z',
                  )
                  .join(' '),
              )
              .join(' ')}
          />
        ))}
      </svg>
    </div>
  );
}
