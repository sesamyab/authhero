import { DataAdapters, Action, fetchAll } from "authhero";
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
  return { ...defaults, actions };
}
