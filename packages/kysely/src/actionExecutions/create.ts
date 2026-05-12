import { Kysely } from "kysely";
import {
  ActionExecution,
  ActionExecutionInsert,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";

export function create(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    execution: ActionExecutionInsert,
  ): Promise<ActionExecution> => {
    const now = Date.now();

    await db
      .insertInto("action_executions")
      .values({
        id: execution.id,
        tenant_id,
        trigger_id: execution.trigger_id,
        status: execution.status,
        results: JSON.stringify(execution.results),
        logs: execution.logs ? JSON.stringify(execution.logs) : null,
        created_at_ts: now,
        updated_at_ts: now,
      })
      .execute();

    return {
      id: execution.id,
      tenant_id,
      trigger_id: execution.trigger_id,
      status: execution.status,
      results: execution.results,
      logs: execution.logs,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    };
  };
}
