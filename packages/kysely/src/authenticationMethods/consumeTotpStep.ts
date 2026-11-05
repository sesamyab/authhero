import { Kysely } from "kysely";
import { Database } from "../db";

export function consumeTotpStep(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    method_id: string,
    step: number,
  ): Promise<boolean> => {
    // Single conditional UPDATE, like codes.consume: two concurrent submits of
    // the same code cannot both match the `totp_last_step < step` predicate.
    const result = await db
      .updateTable("authentication_methods")
      .set({ totp_last_step: step, updated_at_ts: Date.now() })
      .where("authentication_methods.tenant_id", "=", tenant_id)
      .where("authentication_methods.id", "=", method_id)
      .where((eb) =>
        eb.or([
          eb("authentication_methods.totp_last_step", "is", null),
          eb("authentication_methods.totp_last_step", "<", step),
        ]),
      )
      .executeTakeFirst();

    return result.numUpdatedRows > 0;
  };
}
