import { DataAdapters, Action, HookCode, fetchAll } from "authhero";
import { readControlPlaneDefaults } from "../rollout/defaults-projection";
import { ConfigRows } from "./types";

/** Reads every config entity of one tenant as plain rows. */
export async function readConfigRows(
  adapters: DataAdapters,
  tenantId: string,
): Promise<ConfigRows> {
  const defaults = await readControlPlaneDefaults(adapters, tenantId, {
    connections: true,
    resourceServers: true,
    hooks: true,
    emailProvider: true,
    branding: true,
    promptSettings: true,
  });
  const actions = await fetchAll<Action>(
    (params) => adapters.actions.list(tenantId, params),
    "actions",
    { cursorField: "id", pageSize: 100 },
  );

  // hook_code has no list: collect it through the code hooks that point at it.
  // A `code_id` can also point at an action, which `get` then finds instead.
  const actionIds = new Set(actions.map((a) => a.id));
  const codeIds = new Set<string>();
  for (const hook of defaults.hooks) {
    const codeId = (hook as { code_id?: string }).code_id;
    if (codeId && !actionIds.has(codeId)) codeIds.add(codeId);
  }
  const hookCode: HookCode[] = [];
  for (const id of codeIds) {
    const row = await adapters.hookCode.get(tenantId, id);
    if (row) hookCode.push(row);
  }

  return { ...defaults, actions, hookCode };
}
