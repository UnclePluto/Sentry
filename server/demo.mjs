import { readFileSync, existsSync } from 'node:fs';
import { stage, publish } from './store.mjs';
import { KNOWN_NAMES, summarize } from './parser.mjs';
export function seedDemo(db) {
  if (db.prepare('SELECT id FROM imports WHERE demo=1 LIMIT 1').get()) return;
  const places = [
    ['420000', '湖北省', '420100', '武汉市', 114.3, 30.59],
    ['420000', '湖北省', '422800', '恩施土家族苗族自治州', 109.49, 30.27],
    ['420000', '湖北省', '421200', '咸宁市', 114.32, 29.84],
    ['420000', '湖北省', '420500', '宜昌市', 111.29, 30.69],
    ['440000', '广东省', '440100', '广州市', 113.27, 23.13],
    ['440000', '广东省', '440300', '深圳市', 114.06, 22.55],
    ['330000', '浙江省', '330100', '杭州市', 120.15, 30.27],
    ['320000', '江苏省', '320100', '南京市', 118.8, 32.06],
    ['310000', '上海市', '310100', '上海市', 121.47, 31.23],
    ['110000', '北京市', '110100', '北京市', 116.4, 39.9],
    ['510000', '四川省', '510100', '成都市', 104.07, 30.67],
    ['430000', '湖南省', '430100', '长沙市', 112.94, 28.23],
    ['370000', '山东省', '370100', '济南市', 117, 36.65],
    ['610000', '陕西省', '610100', '西安市', 108.94, 34.34],
    ['410000', '河南省', '410100', '郑州市', 113.63, 34.75],
    ['350000', '福建省', '350100', '福州市', 119.3, 26.07],
  ];
  let seed = 67;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const codes = ['IAV', 'IBV', 'RSV', 'HRV', 'ADV', 'MP', 'Spn', 'Hinf'];
  places.forEach(([pc, p, cc, c], index) => {
    const direct = ['110000', '120000', '310000', '500000'].includes(pc);
    const cityCode = direct ? pc : cc;
    const path = `public/maps/${cityCode}.json`;
    const district = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8')).features.find(
          (f) => f.properties.level === 'district',
        )?.properties
      : null;
    const location = {
      province_code: pc,
      province: p,
      city_code: cityCode,
      city: c,
      county_code: index % 3 && district ? String(district.adcode) : '',
      county: index % 3 && district ? district.name : '',
    };
    for (let month = 4; month <= 9; month++) {
      const records = [];
      let excluded = 0;
      const count = 40 + Math.floor(rand() * 40);
      for (let n = 0; n < count; n++) {
        const sample = `DEMO-${index}-${month}-${n}`,
          batch = `SIM-2026${month}`,
          untested = rand() < 0.06;
        if (untested) {
          excluded++;
          continue;
        }
        codes.forEach((code, k) => {
          const positive =
            rand() <
            (0.025 + (month - 4) * 0.012 + (index < 4 ? 0.03 : 0)) *
              (k < 3 ? 1.7 : 1);
          const ct = positive ? Number((19 + rand() * 17).toFixed(2)) : null;
          records.push({
            batch,
            sample,
            code,
            name: KNOWN_NAMES[code],
            status: positive ? 'positive' : 'negative',
            ct,
            raw: positive ? String(ct) : '阴性',
            sourceRow: n + 2,
          });
        });
      }
      const payload = {
        sheet: '模拟数据',
        records,
        names: KNOWN_NAMES,
        warnings: ['演示数据，非真实监测结果'],
        summary: { ...summarize(records), excluded },
      };
      const idImport = stage(db, {
        fileName: '演示数据',
        hash: `demo-${cc}-${month}`,
        location,
        date: `2026-${String(month).padStart(2, '0')}-15`,
        payload,
        demo: 1,
      });
      publish(db, idImport);
    }
  });
}
