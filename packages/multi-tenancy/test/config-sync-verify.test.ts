import { beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import { createInProcessSyncConfig } from "../src/operations";
import {
  applyResolvedConfigBlock,
  buildResolvedConfigBlock,
} from "../src/rollout/resolved-sync";
import { getConfigSyncStatus, verifyTenantConfig } from "../src/rollouts";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const CHILD = "tenant-1";
const CODE = "exports.onExecutePostLogin = async () => {};";

describe("verifyTenantConfig", () => {
  let db: Kysely<Database>;
  let raw: ReturnType<typeof createAdapters>;

  const deps = (
    syncConfig = createInProcessSyncConfig(raw, { controlPlaneTenantId: CP }),
  ) => ({
    adapters: raw,
    controlPlaneTenantId: CP,
    syncConfig,
  });

  beforeEach(async () => {
    db = await createMigratedDb();
    raw = createAdapters(db);
    await raw.tenants.create({ id: CP, friendly_name: "Control Plane" });
    await raw.tenants.create({ id: CHILD, friendly_name: "Child" });
  });

  /** A synced child with a copy of what the control plane publishes. */
  async function syncedChild() {
    await raw.connections.create(CP, {
      name: "google",
      strategy: "google-oauth2",
      options: { client_id: "cp", client_secret: "cp-secret" },
      scope: "shared",
    } as never);
    await raw.actions.create(CP, {
      name: "enrich",
      code: CODE,
      scope: "shared",
    });
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    await applyResolvedConfigBlock(block, raw, CHILD);
    await raw.tenants.update(CHILD, { config_sync: "synced" });
  }

  it("is null for an unknown tenant", async () => {
    expect(await verifyTenantConfig(deps(), "nope")).toBeNull();
  });

  it("has nothing to compare for a detached tenant", async () => {
    await raw.tenants.update(CHILD, { config_sync: "detached" });

    expect(await verifyTenantConfig(deps(), CHILD)).toMatchObject({
      config_sync: "detached",
      method: "not-applicable",
      ok: true,
      differences: [],
    });
  });

  describe("a tenant that inherits on read", () => {
    async function seedMatching() {
      await raw.connections.create(CP, {
        name: "google",
        strategy: "google-oauth2",
        options: { client_id: "cp", client_secret: "cp-secret" },
      });
      await raw.connections.create(CHILD, {
        name: "google",
        strategy: "google-oauth2",
        options: { client_id: "own" },
      });
    }

    it("passes when both models agree", async () => {
      await seedMatching();

      expect(await verifyTenantConfig(deps(), CHILD)).toMatchObject({
        config_sync: "inherit-on-read",
        method: "read-time",
        ok: true,
        differences: [],
      });
    });

    it("fails with the field names, and never with a secret, when the models diverge", async () => {
      await seedMatching();
      const [cpConn] = (await raw.connections.list(CP)).connections;
      await raw.connections.update(CP, cpConn!.id!, { override: "none" });

      const result = await verifyTenantConfig(deps(), CHILD);

      expect(result!.ok).toBe(false);
      expect(result!.differences).toContainEqual(
        expect.objectContaining({
          entity: "connection",
          kind: "changed",
          fields: expect.arrayContaining(["options"]),
        }),
      );
      expect(JSON.stringify(result)).not.toContain("cp-secret");
    });
  });

  describe("a synced tenant", () => {
    it("passes right after a sync", async () => {
      await syncedChild();

      expect(await verifyTenantConfig(deps(), CHILD)).toMatchObject({
        config_sync: "synced",
        method: "sync-dry-run",
        ok: true,
        differences: [],
        errors: [],
      });
    });

    it("sees a copy that was deleted, which the stored hash cannot", async () => {
      await syncedChild();
      const copy = (await raw.actions.list(CHILD)).actions[0]!;
      await raw.actions.remove(CHILD, copy.id);

      const result = await verifyTenantConfig(deps(), CHILD);

      expect(result!.ok).toBe(false);
      expect(result!.differences).toEqual([
        { entity: "action", key: "enrich", kind: "missing" },
      ]);
      const status = await getConfigSyncStatus(
        { adapters: raw, controlPlaneTenantId: CP },
        CHILD,
      );
      expect(status!.drifted).toBe(false);
    });

    it("sees a copy that was edited", async () => {
      await syncedChild();
      const copy = (await raw.actions.list(CHILD)).actions[0]!;
      await raw.actions.update(CHILD, copy.id, { code: "// edited" });

      const result = await verifyTenantConfig(deps(), CHILD);

      expect(result!.ok).toBe(false);
      expect(result!.differences).toEqual([
        { entity: "action", key: "enrich", kind: "changed" },
      ]);
    });

    it("sees a copy the parent no longer publishes", async () => {
      await syncedChild();
      const [shared] = (await raw.actions.list(CP)).actions;
      await raw.actions.remove(CP, shared!.id);

      const result = await verifyTenantConfig(deps(), CHILD);

      expect(result!.ok).toBe(false);
      expect(result!.differences).toEqual([
        { entity: "action", key: "enrich", kind: "stale" },
      ]);
    });

    it("does not count a row the tenant owns as a difference", async () => {
      await syncedChild();
      const [copy] = (await raw.actions.list(CHILD)).actions;
      await raw.actions.remove(CHILD, copy!.id);
      await raw.actions.create(CHILD, { name: "enrich", code: "// mine" });

      expect((await verifyTenantConfig(deps(), CHILD))!.ok).toBe(true);
    });

    it("fails when the dry run reports errors, naming the entity but not the cause", async () => {
      await syncedChild();
      const entity = {
        added: 0,
        changed: 0,
        unchanged: 0,
        deleted: 0,
        errors: [] as string[],
      };
      const syncConfig = async () => ({
        status: "dry-run" as const,
        hash: "h",
        changes: [],
        rows: [],
        entities: {
          connection: { ...entity, errors: ["google: boom"] },
          resourceServer: entity,
          hookCode: entity,
          action: entity,
          hook: entity,
          emailProvider: entity,
          branding: entity,
          promptSettings: entity,
        },
      });

      expect(await verifyTenantConfig(deps(syncConfig), CHILD)).toMatchObject({
        ok: false,
        errors: ["connection: the sync dry run reported 1 error(s)"],
      });
      expect(
        JSON.stringify(await verifyTenantConfig(deps(syncConfig), CHILD)),
      ).not.toContain("boom");
    });

    it("reads the changes of a sender that sends no rows", async () => {
      await syncedChild();
      const entity = {
        added: 0,
        changed: 0,
        unchanged: 0,
        deleted: 0,
        errors: [] as string[],
      };
      const syncConfig = async () =>
        ({
          status: "dry-run",
          hash: "h",
          changes: [
            "action:enrich",
            "delete hook:h_old",
            "skip connection:x (the tenant has its own)",
          ],
          entities: { connection: entity },
        }) as never;

      const result = await verifyTenantConfig(deps(syncConfig), CHILD);

      expect(result!.differences).toEqual([
        { entity: "action", key: "enrich", kind: "changed" },
        { entity: "hook", key: "h_old", kind: "stale" },
      ]);
    });
  });
});
