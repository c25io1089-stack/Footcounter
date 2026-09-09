-- HX-CCD21 Dashboard: анхны схем
-- Multi-tenant: tenants -> locations -> devices (SN)

CREATE TABLE IF NOT EXISTS tenants (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT REFERENCES tenants(id) ON DELETE CASCADE, -- NULL = супер админ
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('superadmin','admin','viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  timezone    TEXT NOT NULL DEFAULT 'Asia/Ulaanbaatar',
  open_time   TIME NOT NULL DEFAULT '09:00',
  close_time  TIME NOT NULL DEFAULT '21:00',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Төхөөрөмж. Танигдаагүй SN ирвэл tenant/location NULL-тэйгээр автоматаар бүртгэнэ.
CREATE TABLE IF NOT EXISTS devices (
  sn              TEXT PRIMARY KEY,
  tenant_id       INT REFERENCES tenants(id) ON DELETE SET NULL,
  location_id     INT REFERENCES locations(id) ON DELETE SET NULL,
  name            TEXT NOT NULL DEFAULT '',
  -- сервер -> төхөөрөмж тохиргоо (heartbeat хариунд илгээнэ)
  upload_interval INT NOT NULL DEFAULT 1,          -- минут: 0 realtime, 1, 5, 60
  data_mode       TEXT NOT NULL DEFAULT 'Add' CHECK (data_mode IN ('Add','Total')),
  timezone_offset INT NOT NULL DEFAULT 8,
  -- түүхэн өгөгдөл дахин татах хүсэлт (heartbeat хариунд dataStartTime/dataEndTime болж явна)
  resync_start    TIMESTAMPTZ,
  resync_end      TIMESTAMPTZ,
  -- төхөөрөмжөөс ирсэн мэдээлэл
  mac_address     TEXT,
  ip_address      TEXT,
  connection_type TEXT,
  host_name       TEXT,
  wifi_ssid       TEXT,
  ip_method       TEXT,
  hw_platform     TEXT,
  sw_release      TEXT,
  last_heartbeat  TIMESTAMPTZ,
  last_data_at    TIMESTAMPTZ,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_tenant_idx ON devices(tenant_id);
CREATE INDEX IF NOT EXISTS devices_location_idx ON devices(location_id);

CREATE TABLE IF NOT EXISTS heartbeats (
  id        BIGSERIAL PRIMARY KEY,
  sn        TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  ts        TIMESTAMPTZ NOT NULL,
  payload   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS heartbeats_sn_ts_idx ON heartbeats(sn, ts DESC);

-- Хүний урсгалын бичлэг (dataUpload). Нэг бичлэг = startTime..endTime интервалын тоо.
CREATE TABLE IF NOT EXISTS flow_records (
  id            BIGSERIAL PRIMARY KEY,
  sn            TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  ts            TIMESTAMPTZ NOT NULL,   -- "time"
  start_time    TIMESTAMPTZ NOT NULL,
  end_time      TIMESTAMPTZ NOT NULL,
  in_count      INT NOT NULL DEFAULT 0,
  out_count     INT NOT NULL DEFAULT 0,
  passby        INT NOT NULL DEFAULT 0,
  turnback      INT NOT NULL DEFAULT 0,
  avg_stay_ms   INT NOT NULL DEFAULT 0,
  data_mode     TEXT NOT NULL DEFAULT 'Add',
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sn, start_time, end_time, ts)
);
CREATE INDEX IF NOT EXISTS flow_sn_ts_idx ON flow_records(sn, ts);
CREATE INDEX IF NOT EXISTS flow_ts_idx ON flow_records(ts);

-- Хүн бүрийн үйл явдал (attributes[]) — нас, хүйс, өндөр, ажилтны карт, тэргэнцэр
CREATE TABLE IF NOT EXISTS person_events (
  id           BIGSERIAL PRIMARY KEY,
  sn           TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  id_index     BIGINT,
  person_id    BIGINT,
  ts           TIMESTAMPTZ NOT NULL,
  event_type   SMALLINT NOT NULL,   -- 0 орсон, 1 гарсан, 2 өнгөрсөн, 3 буцсан
  stay_time_ms INT,
  height_cm    INT,
  gender       SMALLINT,            -- -1 буруу, 0 тодорхойгүй, 1 эр, 2 эм
  age_min      SMALLINT,
  age_max      SMALLINT,
  workcard     SMALLINT DEFAULT 0,
  wheelchair   SMALLINT DEFAULT 0,
  UNIQUE (sn, id_index, ts, event_type)
);
CREATE INDEX IF NOT EXISTS pe_sn_ts_idx ON person_events(sn, ts);

-- Одоо байгаа хүний тоо (residence push, сонголтот)
CREATE TABLE IF NOT EXISTS occupancy_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  sn            TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  ts            TIMESTAMPTZ NOT NULL,
  current_stay  INT NOT NULL,
  info          JSONB
);
CREATE INDEX IF NOT EXISTS occ_sn_ts_idx ON occupancy_snapshots(sn, ts DESC);

-- REID өдрийн тайлан (ажлын цаг дууссаны дараа)
CREATE TABLE IF NOT EXISTS reid_reports (
  id           BIGSERIAL PRIMARY KEY,
  master_sn    TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  report_date  DATE NOT NULL,
  direction    TEXT NOT NULL,
  device_sns   TEXT[] NOT NULL DEFAULT '{}',
  unique_count INT NOT NULL DEFAULT 0,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (master_sn, report_date, direction)
);

CREATE TABLE IF NOT EXISTS reid_persons (
  id              BIGSERIAL PRIMARY KEY,
  report_id       BIGINT NOT NULL REFERENCES reid_reports(id) ON DELETE CASCADE,
  master_sn       TEXT NOT NULL,
  report_date     DATE NOT NULL,
  global_id       BIGINT NOT NULL,
  visit_count     INT NOT NULL DEFAULT 0,
  total_dwell_ms  BIGINT NOT NULL DEFAULT 0,
  first_enter     TIMESTAMPTZ,
  last_leave      TIMESTAMPTZ,
  gender          SMALLINT,
  age_min         SMALLINT,
  age_max         SMALLINT,
  person_type     SMALLINT,   -- 0 зочин, 1 ажилтан, 2 rider, 3 courier
  height_category SMALLINT,   -- 1 насанд хүрэгч, 2 хүүхэд, 0 тодорхойгүй
  pairs           JSONB
);
CREATE INDEX IF NOT EXISTS reid_persons_idx ON reid_persons(master_sn, report_date);

-- Давхардал арилгасан (DUP) тайлан — realtime + final
CREATE TABLE IF NOT EXISTS dedup_reports (
  id            BIGSERIAL PRIMARY KEY,
  master_sn     TEXT NOT NULL REFERENCES devices(sn) ON DELETE CASCADE,
  report_date   DATE NOT NULL,
  direction     TEXT NOT NULL,
  device_sns    TEXT[] NOT NULL DEFAULT '{}',
  raw_count     INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  deduped_count INT NOT NULL DEFAULT 0,
  customer_count INT NOT NULL DEFAULT 0,
  non_customer_count INT NOT NULL DEFAULT 0,
  stats         JSONB NOT NULL,      -- deduped_stats
  records       JSONB,               -- зөвхөн final
  is_final      BOOLEAN NOT NULL DEFAULT false,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (master_sn, report_date, direction)
);

-- Гадаад API түлхүүр
CREATE TABLE IF NOT EXISTS api_keys (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  scopes      TEXT[] NOT NULL DEFAULT '{read}',
  last_used   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

-- Ирсэн түүхий хүсэлтийн лог (дебаг хийхэд; 7 хоног хадгална)
CREATE TABLE IF NOT EXISTS ingest_log (
  id          BIGSERIAL PRIMARY KEY,
  path        TEXT NOT NULL,
  sn          TEXT,
  status      INT NOT NULL,
  message     TEXT,
  body        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_log_created_idx ON ingest_log(created_at);
