import type {
  Feature,
  FeatureCollection,
  Polygon,
  MultiPolygon,
} from 'geojson';
export type DetectionStatus = 'positive' | 'negative' | 'untested';
export interface Stats {
  samples: number;
  tested: number;
  positive: number;
  untested: number;
  rate: number | null;
}
export interface RegionStats extends Stats {
  code: string;
  name: string;
}
export type RegionGroups = Record<
  'province' | 'city' | 'county',
  RegionStats[]
>;
export interface Ranking {
  code: string;
  name: string;
  positive: number;
  tested: number;
  rate: number | null;
}
export interface DashboardData {
  metrics: Stats & {
    notDetected: number;
    excludedNoSelectedTest: number;
    submissions: number;
    pathogens: number;
    regions: number;
  };
  extent: { earliest: string | null; latest: string | null; count: number };
  selectedPathogens: string[];
  pathogenOptions: { code: string; name: string }[];
  ranking: Ranking[];
  trend: (Stats & { month: string })[];
  heatmap: { code: string; month: string; tested: number; count: number }[];
  cooccurrence: { pair: string[]; count: number }[];
  regions: RegionGroups;
  missingPanel: number;
  updatedAt: string | null;
}
export interface SubmissionLocation {
  province_code: string;
  province: string;
  city_code: string;
  city: string;
  county_code: string;
  county: string;
}
export type LegacySubmissionSummary = Stats & {
  rows: number;
  batches: number;
  pathogens: number;
  excluded: number;
};
export type SampleSubmissionSummary = Stats & {
  rows: number;
  negative: number;
  batches: number;
  excluded: 0;
  testedPathogens: number;
  detectedPathogens: number;
  pathogens: number;
};
export type SubmissionSummary =
  | LegacySubmissionSummary
  | SampleSubmissionSummary;
export interface Preview {
  id: string;
  formatVersion: 2;
  sheet: string;
  sheets: ['Sheet1', 'Sheet2'];
  warnings: string[];
  summary: SampleSubmissionSummary;
  location: SubmissionLocation;
  date: string;
}
export interface CommitResult {
  added: number;
  alreadyCommitted: boolean;
}
interface ImportHistoryBase {
  id: string;
  file_name: string;
  province: string;
  city: string;
  county: string;
  report_date: string;
  created_at: string;
  submitted_name: string;
  submitted_username: string;
  status: 'published' | 'withdrawn';
  withdrawn_at: string | null;
  withdrawn_name: string | null;
}
export type ImportHistory = ImportHistoryBase &
  (
    | { formatVersion: 2; summary: SampleSubmissionSummary }
    | { formatVersion: 1; summary: LegacySubmissionSummary }
  );
export interface GeoProperties {
  adcode: number;
  name: string;
  level: 'province' | 'city' | 'district';
  center: [number, number];
  centroid?: [number, number];
  childrenNum?: number;
}
export type GeoFeature = Feature<Polygon | MultiPolygon, GeoProperties>;
export type GeoData = FeatureCollection<Polygon | MultiPolygon, GeoProperties>;
export interface ModelContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: () => unknown;
    },
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}
