import { Kysely } from "kysely";
import {
  Action,
  ActionInsert,
  CreateOptions,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { generateActionId } from "../utils/entity-id";
import { enforceToSql } from "../utils/configInheritance";

export function create(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    action: ActionInsert,
    options?: CreateOptions,
  ): Promise<Action> => {
    const importMetadata = options?.importMetadata;
    const now = Date.now();
    const createdAtTs = importMetadata?.created_at
      ? new Date(importMetadata.created_at).getTime()
      : now;
    const updatedAtTs = importMetadata?.updated_at
      ? new Date(importMetadata.updated_at).getTime()
      : createdAtTs;
    const id = importMetadata?.id ?? generateActionId();

    await db
      .insertInto("actions")
      .values({
        id,
        tenant_id,
        name: action.name,
        code: action.code,
        runtime: action.runtime || null,
        status: "built",
        secrets: action.secrets ? JSON.stringify(action.secrets) : null,
        dependencies: action.dependencies
          ? JSON.stringify(action.dependencies)
          : null,
        supported_triggers: action.supported_triggers
          ? JSON.stringify(action.supported_triggers)
          : null,
        is_system: action.is_system ? 1 : 0,
        inherit: action.inherit ? 1 : 0,
        scope: action.scope ?? null,
        override: action.override ?? null,
        enforce: enforceToSql(action.enforce),
        created_at_ts: createdAtTs,
        updated_at_ts: updatedAtTs,
      })
      .execute();

    return {
      id,
      tenant_id,
      name: action.name,
      code: action.code,
      runtime: action.runtime,
      status: "built",
      secrets: action.secrets?.map((s) => ({ name: s.name })),
      dependencies: action.dependencies,
      supported_triggers: action.supported_triggers,
      is_system: action.is_system ?? false,
      inherit: action.inherit ?? false,
      scope: action.scope,
      override: action.override,
      enforce: action.enforce,
      created_at: new Date(createdAtTs).toISOString(),
      updated_at: new Date(updatedAtTs).toISOString(),
    };
  };
}
