-- The retention DELETE filters on ts alone, which the (monitor, ts) index
-- cannot serve — it was scanning the whole samples table on every cron tick.
CREATE INDEX idx_samples_ts ON samples (ts);
