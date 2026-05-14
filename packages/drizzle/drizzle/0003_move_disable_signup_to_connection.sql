-- Backfill: for every client with disable_sign_ups=1, set the new
-- connection-level disable_signup=true on every connection whose id appears
-- in the client's `connections` JSON array. After the backfill, drop the
-- client column. See packages/kysely/migrate/migrations/2026-05-13T10:00:00_move_disable_signup_to_connection.ts
-- for the matching kysely migration and rationale.

UPDATE `connections`
SET `options` = json_set(coalesce(`options`, '{}'), '$.disable_signup', json('true'))
WHERE EXISTS (
  SELECT 1
  FROM `clients`, json_each(`clients`.`connections`)
  WHERE `clients`.`tenant_id` = `connections`.`tenant_id`
    AND `clients`.`disable_sign_ups` = 1
    AND json_each.value = `connections`.`id`
);
--> statement-breakpoint
ALTER TABLE `clients` DROP COLUMN `disable_sign_ups`;
