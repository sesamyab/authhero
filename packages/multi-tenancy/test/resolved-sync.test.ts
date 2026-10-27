import { beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import {
  createEncryptedDataAdapterWithKeyRing,
  loadEncryptionKey,
} from "authhero";
import { isSyncedRowId } from "authhero";
import { applyControlPlaneDefaultsPayload } from "../src/rollout";
import {
  applyResolvedConfigBlock,
  buildResolvedConfigBlock,
  syncedRowId,
} from "../src/rollout/resolved-sync";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "cp";
const CHILD = "child";
const CODE = "exports.onExecutePostLogin = async () => {};";

const randomKey = () =>
  loadEncryptionKey(
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  );

describe("resolved config sync", () => {
  let db: Kysely<Database>;
  let raw: ReturnType<typeof createAdapters>;
  let cpData: ReturnType<typeof createAdapters>;

  beforeEach(async () => {
    db = await createMigratedDb();
    raw = createAdapters(db);
    for (const id of [CP, CHILD, "mid"]) {
      await raw.tenants.create({ id, friendly_name: id });
    }
    // Control-plane rows are written through a ring that tags them `cp`.
    cpData = createEncryptedDataAdapterWithKeyRing(
      raw,
      { default: await randomKey(), keys: { cp: await randomKey() } },
      { resolveEncryptKeyId: (t) => (t === CP ? "cp" : undefined) },
    ) as typeof raw;
  });

  async function seedControlPlane() {
    const hookCode = await cpData.hookCode.create(CP, {
      code: CODE,
      secrets: { TOKEN: "hook-secret" },
    });
    const action = await cpData.actions.create(CP, {
      name: "enrich",
      code: CODE,
      scope: "shared",
      secrets: [{ name: "API_KEY", value: "action-secret" }],
    });
    await raw.hooks.create(CP, {
      trigger_id: "post-user-login",
      code_id: hookCode.id,
      enabled: true,
      scope: "shared",
    } as any);
    await raw.hooks.create(CP, {
      trigger_id: "post-user-login",
      url: "https://example.com/local-only",
      enabled: true,
    });
    return { hookCode, action };
  }

  it("builds a block with the shared rows only, with a stable hash", async () => {
    const { hookCode } = await seedControlPlane();
    const a = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    const b = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });

    expect(a.chain).toEqual([CP]);
    expect(a.actions.map((x) => x.name)).toEqual(["enrich"]);
    expect(a.hooks).toHaveLength(1);
    expect(a.hookCode.map((x) => x.id)).toEqual([hookCode.id]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("materialises under the child id, remaps code ids and copies ciphertext", async () => {
    const { hookCode } = await seedControlPlane();
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    const result = await applyResolvedConfigBlock(block, raw, CHILD);

    expect(result.status).toBe("applied");
    expect(result.entities.action.added).toBe(1);
    expect(result.entities.hook.added).toBe(1);
    expect(result.entities.hookCode.added).toBe(1);

    const actionId = await syncedRowId("action", CHILD, "enrich");
    const copiedCodeId = await syncedRowId("hookCode", CHILD, hookCode.id);
    expect(copiedCodeId).not.toBe(hookCode.id);

    const hooks = (await raw.hooks.list(CHILD)).hooks;
    expect(hooks).toHaveLength(1);
    expect((hooks[0] as any).code_id).toBe(copiedCodeId);

    // Ciphertext is copied as stored, still tagged with the cp key id.
    const row = await db
      .selectFrom("actions")
      .select("secrets")
      .where("id", "=", actionId)
      .where("tenant_id", "=", CHILD)
      .executeTakeFirst();
    expect(row?.secrets).toContain("enc:v1:cp:");
    expect(row?.secrets).not.toContain("action-secret");

    // The control-plane rows themselves are untouched.
    expect((await raw.actions.list(CP)).actions).toHaveLength(1);
  });

  it("is a no-op when the hash is unchanged and applies only what changed", async () => {
    await seedControlPlane();
    const first = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    await applyResolvedConfigBlock(first, raw, CHILD);
    expect((await raw.tenants.get(CHILD))?.config_sync_hash).toBe(first.hash);

    const again = await applyResolvedConfigBlock(
      await buildResolvedConfigBlock(raw, CHILD, { legacyControlPlane: CP }),
      raw,
      CHILD,
    );
    expect(again.status).toBe("up-to-date");

    const [action] = (await raw.actions.list(CP)).actions;
    await cpData.actions.update(CP, action!.id, { code: `${CODE}\n// v2` });
    const next = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    expect(next.hash).not.toBe(first.hash);
    const result = await applyResolvedConfigBlock(next, raw, CHILD);
    expect(result.status).toBe("applied");
    expect(result.entities.action.changed).toBe(1);
    expect(result.entities.hook.unchanged).toBe(1);
    expect(result.entities.hookCode.unchanged).toBe(1);
  });

  it("writes nothing on a dry run and reports the diff", async () => {
    await seedControlPlane();
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    const result = await applyResolvedConfigBlock(block, raw, CHILD, {
      dryRun: true,
    });

    expect(result.status).toBe("dry-run");
    expect(result.entities.action.added).toBe(1);
    expect(result.changes).toContain("action:enrich");
    expect((await raw.actions.list(CHILD)).actions).toHaveLength(0);
    expect((await raw.hooks.list(CHILD)).hooks).toHaveLength(0);
    expect((await raw.tenants.get(CHILD))?.config_sync_hash).toBeUndefined();
  });

  it("only deletes explicit entries, and only when enabled", async () => {
    await seedControlPlane();
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    await applyResolvedConfigBlock(block, raw, CHILD);
    expect((await raw.actions.list(CHILD)).actions).toHaveLength(1);

    const withDelete = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
      deletes: [{ entity: "action", key: "enrich" }],
    });
    const off = await applyResolvedConfigBlock(withDelete, raw, CHILD);
    expect(off.entities.action.deleted).toBe(0);
    expect(off.changes).toContain("delete action:enrich");
    expect((await raw.actions.list(CHILD)).actions).toHaveLength(1);

    const on = await applyResolvedConfigBlock(withDelete, raw, CHILD, {
      deletes: true,
      force: true,
    });
    expect(on.entities.action.deleted).toBe(1);
  });

  it("runs pending deletes even when the hash is unchanged", async () => {
    await seedControlPlane();
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
      deletes: [{ entity: "action", key: "enrich" }],
    });
    // First apply with deletes disabled: rows are written, the hash is stored.
    await applyResolvedConfigBlock(block, raw, CHILD);
    expect((await raw.actions.list(CHILD)).actions).toHaveLength(1);

    const skipped = await applyResolvedConfigBlock(block, raw, CHILD);
    expect(skipped.status).toBe("up-to-date");

    const run = await applyResolvedConfigBlock(block, raw, CHILD, {
      deletes: true,
    });
    expect(run.status).toBe("applied");
    expect(run.entities.action.deleted).toBe(1);
  });

  describe("pruning stale synced copies", () => {
    async function syncThenUnshare() {
      const { hookCode, action } = await seedControlPlane();
      await raw.actions.create(CP, {
        name: "keep",
        code: CODE,
        scope: "shared",
      });
      const first = await buildResolvedConfigBlock(raw, CHILD, {
        legacyControlPlane: CP,
      });
      await applyResolvedConfigBlock(first, raw, CHILD);
      // The tenant's own row, which a prune must never touch.
      const own = await raw.actions.create(CHILD, { name: "own", code: CODE });
      expect((await raw.actions.list(CHILD)).actions).toHaveLength(3);

      // The parent stops sharing the hook, its code and one action.
      const [hook] = (await raw.hooks.list(CP)).hooks.filter(
        (h) => (h as any).code_id,
      );
      await raw.hooks.remove(CP, hook!.hook_id!);
      await raw.hookCode.remove(CP, hookCode.id);
      await raw.actions.remove(CP, action.id);
      return buildResolvedConfigBlock(raw, CHILD, { legacyControlPlane: CP });
    }

    it("lists stale copies on a dry run and removes nothing", async () => {
      const block = await syncThenUnshare();
      const result = await applyResolvedConfigBlock(block, raw, CHILD, {
        dryRun: true,
      });

      expect(result.changes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^delete hook:/),
          "delete action:enrich",
          expect.stringMatching(/^delete hookCode:/),
        ]),
      );
      expect(result.entities.action.deleted).toBe(0);
      expect((await raw.actions.list(CHILD)).actions).toHaveLength(3);
      expect((await raw.hooks.list(CHILD)).hooks).toHaveLength(1);
    });

    it("leaves stale copies alone unless asked to prune", async () => {
      const block = await syncThenUnshare();
      const result = await applyResolvedConfigBlock(block, raw, CHILD);

      expect(result.changes.some((c) => c.startsWith("delete "))).toBe(false);
      expect((await raw.actions.list(CHILD)).actions).toHaveLength(3);
    });

    it("prunes stale copies, keeps shared and own rows, and ignores the hash", async () => {
      const block = await syncThenUnshare();
      // The hash of the new block is already stored: prune must still look.
      await raw.tenants.update(CHILD, { config_sync_hash: block.hash });

      const result = await applyResolvedConfigBlock(block, raw, CHILD, {
        prune: true,
      });

      expect(result.status).toBe("applied");
      expect(result.entities.hook.deleted).toBe(1);
      expect(result.entities.hookCode.deleted).toBe(1);
      expect(result.entities.action.deleted).toBe(1);
      const names = (await raw.actions.list(CHILD)).actions.map((a) => a.name);
      expect(names.sort()).toEqual(["keep", "own"]);
      expect((await raw.hooks.list(CHILD)).hooks).toHaveLength(0);

      const again = await applyResolvedConfigBlock(block, raw, CHILD, {
        prune: true,
      });
      expect(again.changes.some((c) => c.startsWith("delete "))).toBe(false);
    });

    it("prunes the old code copy of a hook that now points at other code", async () => {
      const { hookCode } = await seedControlPlane();
      const first = await buildResolvedConfigBlock(raw, CHILD, {
        legacyControlPlane: CP,
      });
      await applyResolvedConfigBlock(first, raw, CHILD);
      const oldCopy = await syncedRowId("hookCode", CHILD, hookCode.id);
      expect(await raw.hookCode.get(CHILD, oldCopy)).toBeTruthy();

      // The parent swaps the hook's code for a new row.
      const next = await cpData.hookCode.create(CP, { code: CODE + "// v2" });
      const [hook] = (await raw.hooks.list(CP)).hooks.filter(
        (h) => (h as any).code_id,
      );
      await raw.hooks.update(CP, hook!.hook_id!, { code_id: next.id } as any);
      await raw.hookCode.remove(CP, hookCode.id);

      const block = await buildResolvedConfigBlock(raw, CHILD, {
        legacyControlPlane: CP,
      });
      const result = await applyResolvedConfigBlock(block, raw, CHILD, {
        prune: true,
      });

      expect(result.entities.hookCode.deleted).toBe(1);
      expect(await raw.hookCode.get(CHILD, oldCopy)).toBeFalsy();
      const newCopy = await syncedRowId("hookCode", CHILD, next.id);
      expect(await raw.hookCode.get(CHILD, newCopy)).toBeTruthy();
    });

    it("refuses to prune a block that resolved no ancestors", async () => {
      await seedControlPlane();
      const block = await buildResolvedConfigBlock(raw, CHILD, {
        legacyControlPlane: CP,
      });
      await applyResolvedConfigBlock(block, raw, CHILD);

      await raw.actions.create(CP, {
        name: "added",
        code: CODE,
        scope: "shared",
      });
      const changed = await buildResolvedConfigBlock(raw, CHILD, {
        legacyControlPlane: CP,
      });

      await expect(
        applyResolvedConfigBlock({ ...changed, chain: [] }, raw, CHILD, {
          prune: true,
        }),
      ).rejects.toThrow(/no ancestors/);
      // Not even the upserts ran.
      expect((await raw.actions.list(CHILD)).actions).toHaveLength(1);
    });
  });

  it("refuses to write when the key ring cannot decrypt a key id, naming only the id", async () => {
    await seedControlPlane();
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    const ring = { default: await randomKey() };

    await expect(
      applyResolvedConfigBlock(block, raw, CHILD, { keyRing: ring }),
    ).rejects.toThrow(/"cp"/);
    const error = await applyResolvedConfigBlock(block, raw, CHILD, {
      keyRing: ring,
    }).catch((e) => e as Error);
    expect(error.message).not.toContain("action-secret");
    expect(error.message).not.toContain("hook-secret");
    expect(error.message).not.toContain("enc:v1:");
    expect((await raw.actions.list(CHILD)).actions).toHaveLength(0);
  });

  it("accepts a key ring that holds the key id", async () => {
    await seedControlPlane();
    const cpKey = await randomKey();
    // Re-encrypt under a ring we control so we know the cp key.
    const data = createEncryptedDataAdapterWithKeyRing(
      raw,
      { default: await randomKey(), keys: { cp: cpKey } },
      { resolveEncryptKeyId: (t) => (t === CP ? "cp" : undefined) },
    ) as typeof raw;
    await data.actions.create(CP, {
      name: "second",
      code: CODE,
      scope: "shared",
      secrets: [{ name: "S", value: "v" }],
    });
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    const result = await applyResolvedConfigBlock(
      {
        ...block,
        actions: block.actions.filter((a) => a.name === "second"),
        hooks: [],
        hookCode: [],
      },
      raw,
      CHILD,
      { keyRing: { default: await randomKey(), keys: { cp: cpKey } } },
    );
    expect(result.status).toBe("applied");
    expect(result.entities.action.added).toBe(1);
  });

  it("resolves an explicit two-level chain with the nearest layer winning", async () => {
    await raw.tenants.update("mid", { parent_tenant_id: CP });
    await raw.tenants.update(CHILD, { parent_tenant_id: "mid" });
    await raw.actions.create(CP, {
      name: "shared-action",
      code: "// root",
      scope: "shared",
    });
    await raw.actions.create("mid", {
      name: "shared-action",
      code: "// mid",
      scope: "shared",
    });

    const block = await buildResolvedConfigBlock(raw, CHILD);
    expect(block.chain).toEqual(["mid", CP]);
    expect(block.actions).toHaveLength(1);
    expect(block.actions[0]!.code).toBe("// mid");
  });

  it("leaves the tenant's own rows alone", async () => {
    await seedControlPlane();
    await raw.actions.create(CHILD, { name: "enrich", code: "// mine" });
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    await applyResolvedConfigBlock(block, raw, CHILD);

    const actions = (await raw.actions.list(CHILD)).actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.code).toBe("// mine");
  });

  describe("rows the tenant already has", () => {
    const block = () =>
      buildResolvedConfigBlock(raw, CHILD, { legacyControlPlane: CP });

    it("does not copy a connection or resource server next to the tenant's own", async () => {
      await raw.connections.create(CP, {
        name: "google",
        strategy: "google-oauth2",
        options: { client_id: "cp" },
        scope: "shared",
      } as any);
      await raw.resourceServers.create(CP, {
        identifier: "https://api.example.com",
        name: "api",
        scope: "shared",
      } as any);
      await raw.connections.create(CHILD, {
        name: "google",
        strategy: "google-oauth2",
        options: { client_id: "own" },
      });
      await raw.resourceServers.create(CHILD, {
        identifier: "https://api.example.com",
        name: "own api",
      });

      const result = await applyResolvedConfigBlock(await block(), raw, CHILD);

      expect(result.entities.resourceServer.errors).toEqual([]);
      expect(result.changes).toEqual(
        expect.arrayContaining([
          "skip connection:google-oauth2:google (the tenant has its own)",
          "skip resourceServer:https://api.example.com (the tenant has its own)",
        ]),
      );
      expect((await raw.connections.list(CHILD)).connections).toHaveLength(1);
      expect(
        (await raw.resourceServers.list(CHILD)).resource_servers,
      ).toHaveLength(1);
    });

    it("enables a new synced connection on clients with an explicit list only", async () => {
      await raw.connections.create(CP, {
        name: "google",
        strategy: "google-oauth2",
        options: { client_id: "cp" },
        scope: "shared",
      } as any);
      const own = await raw.connections.create(CHILD, {
        name: "email",
        strategy: "email",
        options: {},
      });
      for (const client_id of ["listed", "unlisted"]) {
        await raw.clients.create(CHILD, {
          client_id,
          client_secret: "s",
          name: client_id,
        });
      }
      await raw.clientConnections.updateByClient(CHILD, "listed", [own.id!]);

      await applyResolvedConfigBlock(await block(), raw, CHILD);

      const copy = await syncedRowId(
        "connection",
        CHILD,
        "google-oauth2:google",
      );
      expect(
        (await raw.clientConnections.listByClient(CHILD, "listed")).map(
          (c) => c.id,
        ),
      ).toEqual([own.id, copy]);
      expect(
        await raw.clientConnections.listByClient(CHILD, "unlisted"),
      ).toEqual([]);

      // A later sync leaves the tenant's choice alone.
      await raw.clientConnections.updateByClient(CHILD, "listed", [own.id!]);
      await applyResolvedConfigBlock(await block(), raw, CHILD, {
        force: true,
      });
      expect(
        (await raw.clientConnections.listByClient(CHILD, "listed")).map(
          (c) => c.id,
        ),
      ).toEqual([own.id]);
    });

    it("replaces a singleton only when the parent locks it", async () => {
      await raw.emailProviders.create(CP, {
        name: "mailgun",
        enabled: true,
        credentials: { api_key: "k1" },
        scope: "shared",
      } as any);
      await raw.emailProviders.create(CHILD, {
        name: "mailgun",
        enabled: true,
        credentials: { api_key: "own" },
      });

      const open = await applyResolvedConfigBlock(await block(), raw, CHILD);
      expect(open.entities.emailProvider.changed).toBe(0);
      expect((await raw.emailProviders.get(CHILD))?.credentials).toEqual({
        api_key: "own",
      });

      await raw.emailProviders.update(CP, { override: "none" } as any);
      const locked = await applyResolvedConfigBlock(await block(), raw, CHILD, {
        force: true,
      });
      expect(locked.entities.emailProvider.changed).toBe(1);
      expect((await raw.emailProviders.get(CHILD))?.credentials).toEqual({
        api_key: "k1",
      });

      const again = await applyResolvedConfigBlock(await block(), raw, CHILD, {
        force: true,
      });
      expect(again.entities.emailProvider.changed).toBe(0);
    });

    it("clears a field the locking parent dropped", async () => {
      await raw.branding.set(CP, {
        logo_url: "https://cp.example.com/logo.png",
        colors: { primary: "#112233" },
        scope: "shared",
        override: "none",
      } as any);
      await applyResolvedConfigBlock(await block(), raw, CHILD);
      expect((await raw.branding.get(CHILD))?.logo_url).toBe(
        "https://cp.example.com/logo.png",
      );

      await raw.branding.set(CP, {
        logo_url: null,
        colors: { primary: "#112233" },
      } as any);
      const result = await applyResolvedConfigBlock(await block(), raw, CHILD);

      expect(result.entities.branding.changed).toBe(1);
      expect((await raw.branding.get(CHILD))?.logo_url).toBeFalsy();
    });

    it("lets the tenant's own row win over an existing synced copy, and prunes the copy", async () => {
      await raw.actions.create(CP, {
        name: "enrich",
        code: CODE,
        scope: "shared",
      });
      await applyResolvedConfigBlock(await block(), raw, CHILD);
      expect((await raw.actions.list(CHILD)).actions).toHaveLength(1);
      await raw.actions.create(CHILD, { name: "enrich", code: "// mine" });

      const preview = await applyResolvedConfigBlock(
        await block(),
        raw,
        CHILD,
        {
          dryRun: true,
        },
      );
      expect(preview.changes).toEqual(
        expect.arrayContaining([
          "skip action:enrich (the tenant has its own)",
          "delete action:enrich",
        ]),
      );

      await applyResolvedConfigBlock(await block(), raw, CHILD, {
        prune: true,
      });
      const actions = (await raw.actions.list(CHILD)).actions;
      expect(actions).toHaveLength(1);
      expect(actions[0]!.code).toBe("// mine");
    });

    it("removes a new synced connection again when enabling it fails, so a retry enables it", async () => {
      await raw.connections.create(CP, {
        name: "google",
        strategy: "google-oauth2",
        options: { client_id: "cp" },
        scope: "shared",
      } as any);
      const own = await raw.connections.create(CHILD, {
        name: "email",
        strategy: "email",
        options: {},
      });
      await raw.clients.create(CHILD, {
        client_id: "listed",
        client_secret: "s",
        name: "listed",
      });
      await raw.clientConnections.updateByClient(CHILD, "listed", [own.id!]);

      const failing = {
        ...raw,
        clientConnections: {
          ...raw.clientConnections,
          addClientToConnection: async () => {
            throw new Error("boom");
          },
        },
      } as typeof raw;
      const first = await applyResolvedConfigBlock(
        await block(),
        failing,
        CHILD,
      );
      expect(first.entities.connection.errors).toHaveLength(1);
      expect((await raw.connections.list(CHILD)).connections).toHaveLength(1);

      await applyResolvedConfigBlock(await block(), raw, CHILD);
      const copy = await syncedRowId(
        "connection",
        CHILD,
        "google-oauth2:google",
      );
      expect(
        (await raw.clientConnections.listByClient(CHILD, "listed")).map(
          (c) => c.id,
        ),
      ).toContain(copy);
    });

    it("applies locked prompt settings and leaves open ones alone", async () => {
      await raw.promptSettings.set(CP, {
        identifier_first: false,
        scope: "shared",
      } as any);
      await raw.promptSettings.set(CHILD, { identifier_first: true });

      await applyResolvedConfigBlock(await block(), raw, CHILD);
      expect((await raw.promptSettings.get(CHILD)).identifier_first).toBe(true);

      await raw.promptSettings.set(CP, { enforce: true } as any);
      const result = await applyResolvedConfigBlock(await block(), raw, CHILD, {
        force: true,
      });
      expect(result.entities.promptSettings.changed).toBe(1);
      expect((await raw.promptSettings.get(CHILD)).identifier_first).toBe(
        false,
      );
    });
  });

  it("applies a payload's resolved block only when asked to", async () => {
    await seedControlPlane();
    const block = await buildResolvedConfigBlock(raw, CHILD, {
      legacyControlPlane: CP,
    });
    const payload = {
      connections: [],
      resourceServers: [],
      hooks: [],
      emailProvider: null,
      branding: null,
      promptSettings: null,
      signingKeys: [],
      tenants: [],
      resolved: block,
    };

    const ignored = await applyControlPlaneDefaultsPayload(payload, raw, CP);
    expect(ignored.resolved).toBeUndefined();
    expect((await raw.actions.list(CHILD)).actions).toHaveLength(0);

    const applied = await applyControlPlaneDefaultsPayload(payload, raw, CP, {
      resolved: { tenantId: CHILD },
    });
    expect(applied.resolved?.status).toBe("applied");
    expect((await raw.actions.list(CHILD)).actions).toHaveLength(1);
  });

  it("derives ids the management API recognises as synced copies", async () => {
    for (const entity of [
      "connection",
      "resourceServer",
      "hook",
      "hookCode",
      "action",
    ] as const) {
      expect(isSyncedRowId(await syncedRowId(entity, CHILD, "any-key"))).toBe(
        true,
      );
    }
  });
});
