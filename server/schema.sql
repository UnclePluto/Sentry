PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS pathogens (code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports (
 id TEXT PRIMARY KEY, file_name TEXT NOT NULL, sha256 TEXT NOT NULL,
 province_code TEXT NOT NULL, province TEXT NOT NULL, city_code TEXT NOT NULL, city TEXT NOT NULL,
 county_code TEXT NOT NULL DEFAULT '', county TEXT NOT NULL DEFAULT '',
 submitted_by TEXT, submitted_name TEXT NOT NULL, submitted_username TEXT NOT NULL DEFAULT '',
 report_date TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('staged','published','withdrawn')),
 source_sheet TEXT NOT NULL, warnings TEXT NOT NULL, payload TEXT NOT NULL, summary TEXT NOT NULL,
 withdrawn_at TEXT, withdrawn_by TEXT, withdrawn_name TEXT,
 demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imports_owner ON imports(submitted_by,created_at);
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
SELECT s.id,s.batch,s.sample_code,i.id import_id,i.report_date,i.demo,
 i.province_code,i.province,i.city_code,i.city,i.county_code,i.county
FROM samples s JOIN imports i ON i.id=s.import_id
WHERE i.status='published';
