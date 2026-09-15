export type ScreenPoint = [number, number];
export type LabelBox = { x: number; y: number; width: number; height: number };
export type ScreenSurface = {
  code: string;
  elevation: number;
  rings: ScreenPoint[][];
  bounds: LabelBox;
};

export function boxesOverlap(a: LabelBox, b: LabelBox, gap = 0) {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap
  );
}

function inside([x, y]: ScreenPoint, ring: ScreenPoint[]) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i],
      [bx, by] = ring[j];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax)
      result = !result;
  }
  return result;
}

/** 在标签所占的屏幕区域检测遮挡，避免用整个省份的包围盒误隐藏邻省名称。 */
export function coveredBySurface(box: LabelBox, surface: ScreenSurface) {
  if (!boxesOverlap(box, surface.bounds)) return false;
  for (const dx of [-0.5, 0, 0.5]) {
    for (const dy of [-0.5, 0, 0.5]) {
      const point: ScreenPoint = [
        box.x + box.width * dx,
        box.y + box.height * dy,
      ];
      if (
        inside(point, surface.rings[0]) &&
        !surface.rings.slice(1).some((ring) => inside(point, ring))
      )
        return true;
    }
  }
  return surface.rings[0].some(
    ([x, y]) =>
      Math.abs(x - box.x) < box.width / 2 &&
      Math.abs(y - box.y) < box.height / 2,
  );
}
