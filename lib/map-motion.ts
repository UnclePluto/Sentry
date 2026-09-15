import type { RegionStats } from './models';
export const FIXED_PITCH = 50;
export const FIXED_BEARING = -18;
export function viewportPolicy(locked: boolean) {
  return {
    scrollZoom: locked ? false : { speed: 0.008, smooth: true },
    dragPan: !locked,
    dragRotate: false,
    doubleClickZoom: false,
    doubleClickDragZoom: false,
    touchZoom: !locked,
    multiTouchDrag: null,
    trackpadGesture: false,
    keyboard: false,
    zoomAround: 'center',
  } as const;
}
export function changedRegions(
  previous: RegionStats[] | null,
  current: RegionStats[],
) {
  if (!previous) return [];
  const before = new Map(previous.map((r) => [r.code, r]));
  const after = new Map(current.map((r) => [r.code, r]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((code) => {
    const a = before.get(code),
      b = after.get(code);
    return (
      (a?.tested || 0) !== (b?.tested || 0) ||
      (a?.positive || 0) !== (b?.positive || 0) ||
      (a?.rate ?? null) !== (b?.rate ?? null)
    );
  });
}
/** 板块高度只表示当前阳性率，不叠加轮巡、悬停或临时高亮偏移。 */
export function plateLift(base: number, rate: number | null) {
  const ratio =
    rate != null && Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 0;
  return base * (0.12 + ratio * 2.5);
}
export function regionColor(
  rate: number | null,
): [number, number, number, number] {
  const colors: [number, number, number][] = [
    [12, 46, 77],
    [18, 84, 118],
    [34, 117, 145],
    [93, 78, 164],
    [152, 68, 158],
  ];
  const index = rate == null ? 0 : Math.min(4, 1 + Math.floor(rate * 4));
  const color = colors[index];
  return [...color, 255];
}

export type MapAppearance = {
  height: number;
  color: [number, number, number, number];
};

/** 新板块从平面浮起；已有板块从当前显示状态连续变化。 */
export function interpolateAppearance(
  start: MapAppearance | undefined,
  target: MapAppearance,
  progress: number,
): MapAppearance {
  const from = start ?? { height: 0, color: target.color };
  const t = Math.max(0, Math.min(1, progress));
  const eased = t * t * (3 - 2 * t);
  return {
    height: from.height + (target.height - from.height) * eased,
    color: target.color.map(
      (value, i) => from.color[i] + (value - from.color[i]) * eased,
    ) as MapAppearance['color'],
  };
}
