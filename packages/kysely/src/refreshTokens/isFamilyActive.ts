import { Kysely } from "kysely";
import { Database } from "../db";

export function isFamilyActive(db: Kysely<Database>) {
  return async (tenant_id: string, family_id: string): Promise<boolean> => {
    const now = Date.now();

    // Two keyed probes rather than one `family_id = ? OR id = ?`: MySQL
    // declines to index_merge across OR'd predicates and falls back to a scan
    // (same reasoning as cleanup.ts). The `id` probe only matters for rows
    // minted before `family_id` was stamped.
    const live = (column: "family_id" | "id") =>
      db
        .selectFrom("refresh_tokens")
        .select("id")
        .where("tenant_id", "=", tenant_id)
        .where(column, "=", family_id)
        .where("revoked_at_ts", "is", null)
        .where("rotated_to", "is", null)
        .where((eb) =>
          eb.or([
            eb("expires_at_ts", "is", null),
            eb("expires_at_ts", ">", now),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb("idle_expires_at_ts", "is", null),
            eb("idle_expires_at_ts", ">", now),
          ]),
        )
        .limit(1)
        .executeTakeFirst();

    if (await live("family_id")) {
      return true;
    }
    return !!(await live("id"));
  };
}
