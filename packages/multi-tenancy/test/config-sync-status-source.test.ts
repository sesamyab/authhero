import { beforeEach, describe, expect, it } from "vitest";
import createAdapters from "@authhero/kysely-adapter";
import {
  applyResolvedConfigBlock,
  buildResolvedConfigBlock,
  syncedRowId,
} from "../src/rollout/resolved-sync";
import { getConfigSyncStatus } from "../src/rollouts";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const MID = "mid";
const LEAF = "leaf";

describe("getConfigSyncStatus, where inherited rows come from", () => {
  let raw: ReturnType<typeof createAdapters>;

  beforeEach(async () => {
    raw = createAdapters(await createMigratedDb());
    await raw.tenants.create({ id: CP, friendly_name: "Control Plane" });
    await raw.connections.create(CP, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "cp" },
      scope: "shared",
    } as never);
  });

  async function sync(tenantId: string, legacyControlPlane?: string) {
    const block = await buildResolvedConfigBlock(raw, tenantId, {
      legacyControlPlane,
    });
    await applyResolvedConfigBlock(block, raw, tenantId);
    await raw.tenants.update(tenantId, { config_sync: "synced" });
  }

  it("credits the control plane when it is in the chain", async () => {
    await raw.tenants.create({
      id: MID,
      friendly_name: "Mid",
      parent_tenant_id: CP,
    });
    await raw.tenants.create({
      id: LEAF,
      friendly_name: "Leaf",
      parent_tenant_id: MID,
    });
    await sync(MID);
    await sync(LEAF);

    const status = await getConfigSyncStatus(
      { adapters: raw, controlPlaneTenantId: CP },
      LEAF,
    );

    const id = await syncedRowId("connection", LEAF, "google-oauth2:google");
    expect(status!.chain).toEqual([MID, CP]);
    expect(status!.inherited[id]).toBe(CP);
  });

  it("credits the parent that holds the copy when the origin is not in the chain", async () => {
    // MID has no parent of its own: the control plane is only its legacy
    // parent, so it is not in the chain of its child.
    await raw.tenants.create({ id: MID, friendly_name: "Mid" });
    await raw.tenants.create({
      id: LEAF,
      friendly_name: "Leaf",
      parent_tenant_id: MID,
    });
    await sync(MID, CP);
    await sync(LEAF);

    const status = await getConfigSyncStatus(
      { adapters: raw, controlPlaneTenantId: CP },
      LEAF,
    );

    const id = await syncedRowId("connection", LEAF, "google-oauth2:google");
    expect(status!.chain).toEqual([MID]);
    expect(status!.inherited[id]).toBe(MID);
  });
});
