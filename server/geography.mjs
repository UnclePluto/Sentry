import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const allowedCodes = new Set(['100000']);
export async function geo(code) {
  if (!/^\d{6}$/.test(code))
    throw Object.assign(Error('行政区代码无效。'), { status: 400 });
  const path = join('public/maps', `${code}.json`);
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    for (const parent of new Set([
      code.slice(0, 4) + '00',
      code.slice(0, 2) + '0000',
      '100000',
    ])) {
      if (parent === code) continue;
      try {
        const parentData = JSON.parse(
          await readFile(join('public/maps', `${parent}.json`), 'utf8'),
        );
        const feature = parentData.features.find(
          (f) => String(f.properties.adcode) === code,
        );
        if (feature) {
          return { type: 'FeatureCollection', features: [feature] };
        }
      } catch {}
    }
    if (!allowedCodes.has(code))
      throw Object.assign(Error('请从上一级地图选择区域。'), { status: 400 });
    try {
      const response = await fetch(
        `https://geo.datav.aliyun.com/areas_v3/bound/${code}_full.json`,
        { signal: AbortSignal.timeout(12000) },
      );
      if (!response.ok) throw new Error();
      data = await response.json();
      if (data.type !== 'FeatureCollection') throw new Error();
      await writeFile(path, JSON.stringify(data));
    } catch {
      throw Object.assign(
        Error('该区域的离线边界尚未下载，请联网后重试，或运行 npm run maps。'),
        { status: 400 },
      );
    }
  }
  for (const f of data.features)
    if (f.properties.adcode) allowedCodes.add(String(f.properties.adcode));
  return data;
}
export async function resolveLocation(x) {
  const find = (data, code, level) =>
    data.features.find(
      (f) =>
        String(f.properties.adcode) === code && f.properties.level === level,
    )?.properties;
  const province = find(await geo('100000'), x.province_code, 'province');
  if (!province)
    throw Object.assign(Error('请选择有效的省份。'), { status: 400 });
  const cities = await geo(x.province_code);
  const direct = ['110000', '120000', '310000', '500000'].includes(
    x.province_code,
  );
  const city =
    direct && x.city_code === x.province_code
      ? province
      : find(cities, x.city_code, 'city');
  if (!city)
    throw Object.assign(Error('请选择该省下有效的城市。'), { status: 400 });
  let county;
  if (x.county_code) {
    county = find(await geo(x.city_code), x.county_code, 'district');
    if (!county)
      throw Object.assign(Error('请选择该市下有效的区县。'), { status: 400 });
  }
  return {
    province_code: x.province_code,
    province: province.name,
    city_code: x.city_code,
    city: city.name,
    county_code: x.county_code || '',
    county: county?.name || '',
  };
}
