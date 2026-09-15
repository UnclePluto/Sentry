'use client';
import { useEffect, useRef, useState } from 'react';
import { interpolateAppearance, type MapAppearance } from '@/lib/map-motion';

/** 高度、填色、轮廓与文字共享同一动画帧，切换目标时保留当前状态。 */
export function useMapAppearance(
  targets: Record<string, MapAppearance>,
  reduced: boolean,
) {
  const current = useRef<Record<string, MapAppearance>>({});
  const [appearance, setAppearance] = useState<Record<string, MapAppearance>>(
    {},
  );
  useEffect(() => {
    if (!Object.keys(targets).length) return;
    const start = current.current;
    if (
      reduced ||
      Object.entries(targets).every(([code, value]) => {
        const from = start[code];
        return (
          from &&
          Math.abs(from.height - value.height) < 0.01 &&
          from.color.every(
            (channel, i) => Math.abs(channel - value.color[i]) < 0.01,
          )
        );
      })
    ) {
      current.current = targets;
      setAppearance(targets);
      return;
    }
    let frame = 0,
      last = 0;
    const begun = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - begun) / 1000);
      if (now - last >= 32 || progress === 1) {
        last = now;
        const next = Object.fromEntries(
          Object.entries(targets).map(([code, value]) => [
            code,
            interpolateAppearance(start[code], value, progress),
          ]),
        );
        current.current = next;
        setAppearance(next);
      }
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [targets, reduced]);
  return appearance;
}
