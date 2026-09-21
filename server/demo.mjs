import { readFileSync, existsSync } from 'node:fs';
import { stage, publishInTransaction } from './store.mjs';
import { KNOWN_NAMES, summarizeSamples } from './parser.mjs';
import { lockWrites } from './write-gate.mjs';

const places = [
  ['420000', '湖北省', '420100', '武汉市'],
  ['420000', '湖北省', '422800', '恩施土家族苗族自治州'],
  ['420000', '湖北省', '421200', '咸宁市'],
  ['420000', '湖北省', '420500', '宜昌市'],
  ['440000', '广东省', '440100', '广州市'],
  ['440000', '广东省', '440300', '深圳市'],
  ['330000', '浙江省', '330100', '杭州市'],
  ['320000', '江苏省', '320100', '南京市'],
  ['310000', '上海市', '310100', '上海市'],
  ['110000', '北京市', '110100', '北京市'],
  ['510000', '四川省', '510100', '成都市'],
  ['430000', '湖南省', '430100', '长沙市'],
  ['370000', '山东省', '370100', '济南市'],
  ['610000', '陕西省', '610100', '西安市'],
  ['410000', '河南省', '410100', '郑州市'],
  ['350000', '福建省', '350100', '福州市'],
];
const codes = ['IAV', 'IBV', 'RSV', 'HRV', 'ADV', 'MP', 'Spn', 'Hinf'];
const panel = codes.map((code, index) => ({
  code,
  name: KNOWN_NAMES[code],
  rawName: KNOWN_NAMES[code],
  sourceRow: index + 2,
}));
const names = Object.fromEntries(panel.map(({ code, name }) => [code, name]));

function payloadFor(index, month, rand) {
  const samples = [],
    detections = [];
  let sourceRow = 2;
  const count = 40 + Math.floor(rand() * 40);
  for (let n = 0; n < count; n++) {
    const sample = `DEMO-${index}-${month}-${n}`,
      batch = `SIM-2026${month}`,
      found = [];
    for (const [pathogenIndex, code] of codes.entries()) {
      const positive =
        rand() <
        (0.025 + (month - 4) * 0.012 + (index < 4 ? 0.03 : 0)) *
          (pathogenIndex < 3 ? 1.7 : 1);
      if (positive) found.push(code);
    }
    const sampleRow = sourceRow;
    samples.push({
      sample,
      batch,
      resultKind: found.length ? 'has_positive' : 'all_negative',
      sourceRow: sampleRow,
    });
    if (!found.length) {
      sourceRow++;
      continue;
    }
    for (const code of found) {
      const ct = Number((19 + rand() * 17).toFixed(2));
      detections.push({
        sample,
        code,
        ct,
        raw: String(ct),
        name: KNOWN_NAMES[code],
        sourceRow: sourceRow++,
      });
    }
  }
  const rows =
    samples.filter((sample) => sample.resultKind === 'all_negative').length +
    detections.length;
  return {
    formatVersion: 2,
    sheet: 'Sheet1',
    sheets: ['Sheet1', 'Sheet2'],
    panel,
    samples,
    detections,
    names,
    warnings: ['演示数据，非真实监测结果'],
    summary: summarizeSamples(samples, detections, panel, rows),
  };
}

export async function seedDemo(db) {
  return db.transaction(async (tx) => {
    await lockWrites(tx);
    await tx.query(
      `UPDATE imports SET status='withdrawn',withdrawn_at=now(),
         withdrawn_name='系统升级旧演示数据'
       WHERE demo=1 AND status='published' AND format_version=1`,
    );
    const existing = await tx.get(
      `SELECT count(*) total,
         count(*) FILTER(WHERE
           EXISTS(SELECT 1 FROM import_pathogens p WHERE p.import_id=i.id)
           AND EXISTS(SELECT 1 FROM samples s
                      WHERE s.import_id=i.id AND s.format_version=2)
         ) complete
       FROM imports i
       WHERE demo=1 AND status='published' AND format_version=2`,
    );
    if (existing.total > 0 && existing.total === existing.complete) return;
    await tx.query(
      `UPDATE imports SET status='withdrawn',withdrawn_at=now(),
         withdrawn_name='系统重建不完整演示数据'
       WHERE demo=1 AND status='published'`,
    );

    let seed = 67;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (const [
      index,
      [provinceCode, province, rawCityCode, city],
    ] of places.entries()) {
      const direct = ['110000', '120000', '310000', '500000'].includes(
        provinceCode,
      );
      const cityCode = direct ? provinceCode : rawCityCode;
      const path = `public/maps/${cityCode}.json`;
      const district = existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf8')).features.find(
            (feature) => feature.properties.level === 'district',
          )?.properties
        : null;
      const location = {
        province_code: provinceCode,
        province,
        city_code: cityCode,
        city,
        county_code: index % 3 && district ? String(district.adcode) : '',
        county: index % 3 && district ? district.name : '',
      };
      for (let month = 4; month <= 9; month++) {
        const payload = payloadFor(index, month, rand);
        const importId = await stage(tx, {
          fileName: '演示数据',
          hash: `demo-${rawCityCode}-${month}`,
          location,
          date: `2026-${String(month).padStart(2, '0')}-15`,
          payload,
          demo: 1,
        });
        await publishInTransaction(tx, importId);
      }
    }
  });
}
