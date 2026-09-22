-- Repair pocket-id's francis_metadata `last-cleanup` marker.
--
-- `francis` (pocket-id's job scheduler) stores its last-run marker in
-- francis_metadata.value as TEXT. A version bump changed the encoding
-- from epoch-milliseconds to a timestamp string with no data migration,
-- so the scheduler's upsert — whose WHERE clause casts the STORED value
-- to timestamp — errors with SQLSTATE 22008 and can never rewrite the
-- row it trips over. Expired-data cleanup is wedged until the stale
-- value is replaced.
--
-- The regexp makes this a no-op once the row already holds a timestamp;
-- the to_regclass guard makes it a no-op on a fresh install where
-- pocket-id has not created the table yet.

DO $$
BEGIN
  IF to_regclass('public.francis_metadata') IS NOT NULL THEN
    UPDATE francis_metadata
       SET value = (now() AT TIME ZONE 'utc')::text
     WHERE key = 'last-cleanup'
       AND value ~ '^[0-9]+$';
  END IF;
END $$;
