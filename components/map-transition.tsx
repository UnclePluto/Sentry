'use client';
import { useEffect, useRef } from 'react';
import type { ScreenSurface } from '@/lib/map-labels';

export type MapJourney = { direction: 'in' | 'out'; focusCode: string };
export function MapTransition({
  journey,
  phase,
  surfaces,
  width,
  height,
  color,
  onComplete,
}: {
  journey: MapJourney;
  phase: 'exit' | 'enter';
  surfaces: ScreenSurface[];
  width: number;
  height: number;
  color: (code: string) => string;
  onComplete: () => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const done = useRef(onComplete);
  done.current = onComplete;
  // 一次过渡使用开始时的几何快照，避免轮巡或数据刷新改变飞出方向。
  const snapshot = useRef(surfaces).current;
  useEffect(() => {
    if (!svg.current) return;
    const center = { x: width / 2, y: height / 2 };
    const selected = snapshot.filter((s) => s.code === journey.focusCode);
    const focus = selected.length
      ? selected.reduce((a, b) =>
          b.bounds.width * b.bounds.height > a.bounds.width * a.bounds.height
            ? b
            : a,
        ).bounds
      : center;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : 650;
    const animations = [
      ...svg.current.querySelectorAll<SVGGElement>('g[data-code]'),
    ].map((node) => {
      const isSelected = node.dataset.code === journey.focusCode;
      const x = Number(node.dataset.x),
        y = Number(node.dataset.y);
      const angle = Math.atan2(y - focus.y, x - focus.x);
      const scatter = `translate(${Math.cos(angle) * width * 0.65}px, ${Math.sin(angle) * height * 0.65}px) scale(.7)`;
      const expand = `translate(${center.x - focus.x}px, ${center.y - focus.y}px) scale(2.6)`;
      const shrink = 'scale(.25)';
      let frames: Keyframe[];
      if (phase === 'exit' && journey.direction === 'in') {
        node.style.transformOrigin = `${focus.x}px ${focus.y}px`;
        frames = [
          { transform: 'none', opacity: 1 },
          {
            transform: isSelected ? expand : scatter,
            opacity: isSelected ? 0.85 : 0,
          },
        ];
      } else if (phase === 'enter' && journey.direction === 'out') {
        node.style.transformOrigin = `${focus.x}px ${focus.y}px`;
        frames = [
          {
            transform: isSelected ? expand : scatter,
            opacity: isSelected ? 0.7 : 0,
          },
          { transform: 'none', opacity: 1 },
        ];
      } else {
        node.style.transformOrigin = `${center.x}px ${center.y}px`;
        frames =
          phase === 'exit'
            ? [
                { transform: 'none', opacity: 1 },
                { transform: shrink, opacity: 0 },
              ]
            : [
                { transform: 'scale(.88)', opacity: 0 },
                { transform: 'none', opacity: 1 },
              ];
      }
      return node.animate(frames, {
        duration,
        easing: 'cubic-bezier(.22,.7,.25,1)',
        fill: 'both',
      });
    });
    let cancelled = false;
    Promise.all(animations.map((a) => a.finished))
      .then(() => {
        if (!cancelled) done.current();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      animations.forEach((a) => a.cancel());
    };
  }, [journey, phase, width, height, snapshot]);
  return (
    <svg
      ref={svg}
      className="map-transition-layer"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {snapshot.map((surface, index) => (
        <g
          key={index}
          data-code={surface.code}
          data-x={surface.bounds.x}
          data-y={surface.bounds.y}
        >
          <path
            d={surface.rings
              .map(
                (ring) =>
                  ring
                    .map(
                      ([x, y], i) =>
                        `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`,
                    )
                    .join(' ') + 'Z',
              )
              .join(' ')}
            fill={color(surface.code)}
            fillRule="evenodd"
            stroke="#69c5e8"
            strokeWidth=".65"
          />
        </g>
      ))}
    </svg>
  );
}
