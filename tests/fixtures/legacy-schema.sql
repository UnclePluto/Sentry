PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS institutions (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, province_code TEXT NOT NULL, province TEXT NOT NULL,
 city_code TEXT NOT NULL, city TEXT NOT NULL, county_code TEXT NOT NULL DEFAULT '', county TEXT NOT NULL DEFAULT '',
 longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180), latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 coordinate_note TEXT NOT NULL DEFAULT '机构坐标', demo INTEGER NOT NULL DEFAULT 0 CHECK(demo IN (0,1)),
 UNIQUE(name,province_code,city_code,county_code,demo)
);
CREATE TABLE IF NOT EXISTS pathogens (code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports (
 id TEXT PRIMARY KEY, file_name TEXT NOT NULL, sha256 TEXT NOT NULL, institution_id TEXT NOT NULL REFERENCES institutions(id),
 report_date TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('staged','published','withdrawn')),
 source_sheet TEXT NOT NULL, warnings TEXT NOT NULL, payload TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imports_hash ON imports(sha256,institution_id,report_date,status);
CREATE TABLE IF NOT EXISTS samples (
 id INTEGER PRIMARY KEY, import_id TEXT NOT NULL REFERENCES imports(id), batch TEXT NOT NULL, sample_code TEXT NOT NULL,
 UNIQUE(import_id,batch,sample_code)
);
CREATE TABLE IF NOT EXISTS results (
 id INTEGER PRIMARY KEY, sample_id INTEGER NOT NULL REFERENCES samples(id), pathogen_code TEXT NOT NULL REFERENCES pathogens(code),
 status TEXT NOT NULL CHECK(status IN ('positive','negative','untested')), ct REAL, raw_value TEXT NOT NULL, raw_name TEXT NOT NULL,
 source_row INTEGER NOT NULL, UNIQUE(sample_id,pathogen_code)
);
CREATE INDEX IF NOT EXISTS idx_results_sample ON results(sample_id);
CREATE VIEW IF NOT EXISTS current_samples AS
SELECT * FROM (
 SELECT s.id,s.batch,s.sample_code,i.id import_id,i.institution_id,i.report_date,i.demo,
 ROW_NUMBER() OVER(PARTITION BY i.institution_id,s.batch,s.sample_code ORDER BY i.report_date DESC,i.created_at DESC,i.id DESC) rank
 FROM samples s JOIN imports i ON i.id=s.import_id WHERE i.status='published'
) WHERE rank=1;
PRAGMA user_version = 1;
