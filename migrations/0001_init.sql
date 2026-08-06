-- Raw check results. Pruned by the cron to `retain_days` (default 7) — the
-- 90-day view is served from `daily`, this table only backs the recent-window
-- alarm rules and the "last checked" line on each card.
CREATE TABLE samples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor    TEXT    NOT NULL,
  ts         INTEGER NOT NULL,          -- unix seconds
  ok         INTEGER NOT NULL,          -- 0 | 1
  degraded   INTEGER NOT NULL DEFAULT 0,-- 0 | 1, only meaningful when ok = 1
  status     INTEGER,                   -- HTTP status, null for heartbeats
  latency_ms INTEGER,
  error      TEXT
);
CREATE INDEX idx_samples_monitor_ts ON samples (monitor, ts DESC);

-- One row per monitor per UTC day. `degraded` is a subset of `ok`, so
-- uptime = ok / (ok + fail).
CREATE TABLE daily (
  monitor  TEXT    NOT NULL,
  day      TEXT    NOT NULL,            -- YYYY-MM-DD, UTC
  ok       INTEGER NOT NULL DEFAULT 0,
  fail     INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (monitor, day)
);

-- An incident is open while `resolved_at` is null. At most one open incident
-- per monitor, enforced by the partial unique index.
CREATE TABLE incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor     TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  reason      TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_incidents_one_open ON incidents (monitor) WHERE resolved_at IS NULL;
CREATE INDEX idx_incidents_started ON incidents (started_at DESC);

-- Last received ping per heartbeat monitor.
CREATE TABLE heartbeats (
  monitor   TEXT    PRIMARY KEY,
  last_ping INTEGER NOT NULL
);
