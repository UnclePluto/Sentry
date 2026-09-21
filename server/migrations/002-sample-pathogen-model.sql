ALTER TABLE imports
  ADD COLUMN format_version smallint NOT NULL DEFAULT 1
  CHECK(format_version IN (1,2));
ALTER TABLE imports
  ADD CONSTRAINT imports_id_format_unique UNIQUE(id,format_version);

ALTER TABLE samples
  ADD COLUMN format_version smallint NOT NULL DEFAULT 1
  CHECK(format_version IN (1,2));
ALTER TABLE samples ADD COLUMN result_kind text;
ALTER TABLE samples ADD COLUMN source_row integer;
ALTER TABLE samples
  ADD CONSTRAINT samples_id_import_unique UNIQUE(import_id,id);
ALTER TABLE samples
  ADD CONSTRAINT samples_import_format_fk
  FOREIGN KEY(import_id,format_version)
  REFERENCES imports(id,format_version);
ALTER TABLE samples
  ADD CONSTRAINT samples_v2_result_check CHECK(
    format_version=1 OR (
      result_kind IN ('all_negative','has_positive')
      AND source_row IS NOT NULL
      AND source_row>0
    )
  );
CREATE UNIQUE INDEX samples_v2_identity
  ON samples(import_id,sample_code)
  WHERE format_version=2;

CREATE TABLE import_pathogens (
  import_id text NOT NULL REFERENCES imports(id),
  pathogen_code text NOT NULL REFERENCES pathogens(code)
    CHECK(pathogen_code<>'N'),
  raw_name text NOT NULL DEFAULT '',
  source_row integer NOT NULL CHECK(source_row>0),
  PRIMARY KEY(import_id,pathogen_code)
);
CREATE INDEX import_pathogens_code
  ON import_pathogens(pathogen_code,import_id);

CREATE TABLE sample_detections (
  import_id text NOT NULL,
  sample_id bigint NOT NULL,
  pathogen_code text NOT NULL,
  ct double precision,
  raw_value text NOT NULL,
  raw_name text NOT NULL,
  source_row integer NOT NULL CHECK(source_row>0),
  PRIMARY KEY(sample_id,pathogen_code),
  FOREIGN KEY(import_id,sample_id)
    REFERENCES samples(import_id,id),
  FOREIGN KEY(import_id,pathogen_code)
    REFERENCES import_pathogens(import_id,pathogen_code)
);
CREATE INDEX sample_detections_code
  ON sample_detections(pathogen_code,sample_id);

CREATE TABLE import_detection_groups (
  import_id text NOT NULL REFERENCES imports(id),
  group_no integer NOT NULL CHECK(group_no>0),
  positive_codes text[] NOT NULL
    CHECK(array_position(positive_codes,NULL) IS NULL),
  sample_count bigint NOT NULL CHECK(sample_count>0),
  PRIMARY KEY(import_id,group_no)
);
