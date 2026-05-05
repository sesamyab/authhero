import { Kysely } from "kysely";
import { Database } from "../db";
import { isoToDbDate } from "../utils/dateConversion";

export function revokeFamily(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    family_id: string,
    revoked_at: string,
  ): Promise<number> => {
    const revokedAtTs = isoToDbDate(revoked_at);

    const results = await db
      .updateTable("refresh_tokens")
      .set({ revoked_at_ts: revokedAtTs })
      .where("tenant_id", "=", tenant_id)
      .where("family_id", "=", family_id)
      .where("revoked_at_ts", "is", null)
      .executeTakeFirst();

    return Number(results.numUpdatedRows ?? 0);
  };
}
