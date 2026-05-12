import { Kysely } from "kysely";
import {
  ActionExecution,
  ActionExecutionLogs,
  ActionExecutionResult,
  ActionExecutionStatus,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";

function parseJsonField<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function get(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    execution_id: string,
  ): Promise<ActionExecution | null> => {
    const row = await db
      .selectFrom("action_executions")
      .where("action_executions.tenant_id", "=", tenant_id)
      .where("action_executions.id", "=", execution_id)
      .selectAll()
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      tenant_id: row.tenant_id,
      trigger_id: row.trigger_id,
      status: row.status as ActionExecutionStatus,
      results:
        parseJsonField<ActionExecutionResult[]>(row.results) ?? [],
      logs: parseJsonField<ActionExecutionLogs>(row.logs),
      created_at: new Date(Number(row.created_at_ts)).toISOString(),
      updated_at: new Date(Number(row.updated_at_ts)).toISOString(),
    };
  };
}
