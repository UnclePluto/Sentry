import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../lib/map-motion.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const {
  viewportPolicy,
  changedRegions,
  plateLift,
  regionColor,
  interpolateAppearance,
} = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

test('锁定禁止拖拽和缩放；解锁允许平移缩放但保持固定角度', () => {
  for (const locked of [true, false]) {
    const policy = viewportPolicy(locked);
    assert.equal(policy.dragRotate, false);
    assert.equal(policy.dragPan, !locked);
    assert.equal(policy.keyboard, false);
    assert.equal(policy.doubleClickZoom, false);
    assert.equal(policy.touchZoom, !locked);
    assert.equal(Boolean(policy.scrollZoom), !locked);
  }
});

test('只强调发生统计变化的板块，高度仅随阳性率变化', () => {
  const a = { code: '420000', tested: 10, positive: 2, rate: 0.2 };
  const b = { code: '430000', tested: 20, positive: 10, rate: 0.5 };
  assert.deepEqual(changedRegions(null, [a]), []);
  assert.deepEqual(changedRegions([a, b], [b, a]), []);
  assert.deepEqual(
    changedRegions([a, b], [a, { ...b, positive: 12, rate: 0.6 }]),
    [b.code],
  );
  assert.deepEqual(changedRegions([a, b], [a]), [b.code]);
  assert.equal(
    plateLift(100, 0.2, true, true),
    plateLift(100, 0.2, false, false),
  );
  assert.ok(plateLift(100, 0.8) > plateLift(100, 0.2));
  assert.equal(plateLift(100, 0), plateLift(100, null));
  assert.equal(plateLift(0, 0.8), 0);
  assert.equal(plateLift(100, 2), plateLift(100, 1));
});

test('首次从平面浮起，切换日期从当前高度与颜色继续过渡', () => {
  const first = { height: 100, color: regionColor(0.2) };
  assert.deepEqual(interpolateAppearance(undefined, first, 0), {
    height: 0,
    color: first.color,
  });
  assert.deepEqual(interpolateAppearance(undefined, first, 1), first);
  const next = { height: 300, color: regionColor(0.8) };
  const midway = interpolateAppearance(first, next, 0.5);
  assert.equal(midway.height, 200);
  assert.deepEqual(
    midway.color,
    first.color.map((v, i) => (v + next.color[i]) / 2),
  );
  const last = { height: 50, color: regionColor(0) };
  assert.deepEqual(interpolateAppearance(midway, last, 0), midway);
  assert.deepEqual(interpolateAppearance(midway, last, 1), last);
  assert.deepEqual(interpolateAppearance(last, last, 0.5), last);
  assert.deepEqual(
    regionColor(0.2, true, true),
    regionColor(0.2, false, false),
  );
});
