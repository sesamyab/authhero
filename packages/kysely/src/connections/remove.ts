import { Kysely } from "kysely";
import { Database } from "../db";

export function remove(db: Kysely<Database>) {
  return async (tenant_id: string, connection_id: string): Promise<boolean> => {
    // The connection's Self-Service SSO domain claims go with it; claims of
    // other connections on the same domain stay.
    return db.transaction().execute(async (trx) => {
      const result = await trx
        .deleteFrom("connections")
        .where("connections.tenant_id", "=", tenant_id)
        .where("connections.id", "=", connection_id)
        .executeTakeFirst();
      await trx
        .deleteFrom("connection_domains")
        .where("tenant_id", "=", tenant_id)
        .where("connection_id", "=", connection_id)
        .execute();
      return result.numDeletedRows > 0;
    });
  };
}
