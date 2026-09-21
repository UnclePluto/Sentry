'use client';
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart, HeatmapChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
]);
export default function Chart({
  option,
  height = 220,
  label,
}: {
  option: echarts.EChartsCoreOption;
  height?: number | string;
  label: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const instance = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    instance.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    instance.current?.setOption(
      {
        ...option,
        textStyle: {
          fontFamily: 'PingFang SC, sans-serif',
          ...option.textStyle,
        },
      },
      { replaceMerge: ['series'] },
    );
  }, [option]);
  return (
    <figure
      aria-label={label}
      ref={ref}
      style={{ height, width: '100%', margin: 0 }}
    />
  );
}
