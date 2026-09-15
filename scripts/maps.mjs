import { mkdir, writeFile, readFile } from 'node:fs/promises';
await mkdir('public/maps', { recursive: true });
async function get(code) {
  const path = `public/maps/${code}.json`;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {}
  const res = await fetch(
    `https://geo.datav.aliyun.com/areas_v3/bound/${code}_full.json`,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!res.ok) throw new Error(String(res.status));
  const json = await res.json();
  if (json.type !== 'FeatureCollection') throw new Error('invalid');
  await writeFile(path, JSON.stringify(json));
  return json;
}
const china = await get('100000');
const provinces = china.features
  .map((f) => f.properties)
  .filter((p) => p.adcode && p.level === 'province');
const queue = provinces.map((p) => String(p.adcode));
let count = 0;
const failed = [];
async function worker() {
  while (queue.length) {
    const code = queue.shift();
    try {
      const geo = await get(code);
      count++;
      if (provinces.some((p) => String(p.adcode) === code))
        for (const f of geo.features) {
          const p = f.properties;
          if (p.level === 'city' && p.childrenNum > 0)
            queue.push(String(p.adcode));
        }
    } catch {
      failed.push(code);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, () => worker()));
console.log(
  `已缓存 ${count + 1} 份行政区边界；未下载：${failed.join('、') || '无'}`,
);
