import { Kysely } from "kysely";
import { ActionUpdate } from "@authhero/adapter-interfaces";
import { Database } from "../db";

type StoredSecret = { name: string; value?: string };

function parseStoredSecrets(raw: string | null | undefined): StoredSecret[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function update(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    action_id: string,
    action: ActionUpdate,
  ): Promise<boolean> => {
    const sqlValues: Record<string, unknown> = {
      updated_at_ts: Date.now(),
    };

    if (action.name !== undefined) {
      sqlValues.name = action.name;
    }
    if (action.code !== undefined) {
      sqlValues.code = action.code;
    }
    if (action.runtime !== undefined) {
      sqlValues.runtime = action.runtime;
    }
    if (action.secrets !== undefined) {
      // Merge: an incoming secret without `value` preserves the existing value
      // for that name. Lets PATCH callers (e.g., admin UI) round-trip the
      // masked secret list without overwriting stored values.
      const existingRow = await db
        .selectFrom("actions")
        .where("actions.id", "=", action_id)
        .where("actions.tenant_id", "=", tenant_id)
        .select("secrets")
        .executeTakeFirst();
      const existingByName = new Map(
        parseStoredSecrets(existingRow?.secrets).map((s) => [s.name, s]),
      );
      const merged = action.secrets.map((s) =>
        s.value === undefined
          ? { name: s.name, value: existingByName.get(s.name)?.value }
          : s,
      );
      sqlValues.secrets = JSON.stringify(merged);
    }
    if (action.dependencies !== undefined) {
      sqlValues.dependencies = JSON.stringify(action.dependencies);
    }
    if (action.supported_triggers !== undefined) {
      sqlValues.supported_triggers = JSON.stringify(action.supported_triggers);
    }
    if (action.status !== undefined) {
      sqlValues.status = action.status;
    }
    if (action.deployed_at !== undefined) {
      const parsedTs = new Date(action.deployed_at).getTime();
      if (Number.isFinite(parsedTs)) {
        sqlValues.deployed_at_ts = parsedTs;
      }
    }

    const result = await db
      .updateTable("actions")
      .set(sqlValues)
      .where("actions.id", "=", action_id)
      .where("actions.tenant_id", "=", tenant_id)
      .executeTakeFirst();

    return result.numUpdatedRows > 0;
  };
}
