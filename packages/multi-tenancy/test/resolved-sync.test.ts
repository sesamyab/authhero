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

    it("refuses to prune a block that resolved no ancestors", async () => {
      await seedControlPlane();
      const block = await buildResolvedConfigBlock(raw, CHILD, {
        legacyControlPlane: CP,
      });
      await applyResolvedConfigBlock(block, raw, CHILD);

      await expect(
        applyResolvedConfigBlock({ ...block, chain: [] }, raw, CHILD, {
          prune: true,
        }),
      ).rejects.toThrow(/no ancestors/);
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
    expect(actions).toHaveLength(2);
    expect(actions.find((a) => a.code === "// mine")).toBeDefined();
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
