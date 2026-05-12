import { ActionExecution, ActionExecutionInsert } from "../types";

export interface ActionExecutionsAdapter {
  create: (
    tenant_id: string,
    execution: ActionExecutionInsert,
  ) => Promise<ActionExecution>;
  get: (
    tenant_id: string,
    execution_id: string,
  ) => Promise<ActionExecution | null>;
}
