import { describe, it, expect, beforeEach } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import createAdapters, {
  Database,
  migrateToLatest,
} from "@authhero/kysely-adapter";
import { DataAdapters, encodeBase64 } from "@authhero/adapter-interfaces";
import {
  canDecrypt,
  createEncryptedDataAdapter,
  createEncryptedDataAdapterWithKeyRing,
  encryptFieldWithRing,
  loadEncryptionKey,
} from "../../src";

async function randomKey() {
  return loadEncryptionKey(
    encodeBase64(crypto.getRandomValues(new Uint8Array(32))),
  );
}

async function setup() {
  const sqlite = new SQLite(":memory:");
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  await migrateToLatest(db, false);

  const raw: DataAdapters = createAdapters(db);
  const key = await randomKey();
  const data = createEncryptedDataAdapter(raw, key);

  for (const id of ["t1", "cp"]) {
    await raw.tenants.create({
      id,
      friendly_name: id,
      audience: "https://example.com",
      default_audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "Sender",
    });
  }
  return { db, raw, data, key };
}

const CODE = "exports.onExecutePostLogin = async () => {};";

describe("encrypted action and hook_code secrets", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  async function rawActionSecrets(id: string) {
    const row = await ctx.db
      .selectFrom("actions")
      .select("secrets")
      .where("id", "=", id)
      .executeTakeFirst();
    return JSON.parse(row!.secrets!) as Array<{ name: string; value: string }>;
  }

  it("encrypts action secret values at rest and returns plaintext on get and list", async () => {
    const created = await ctx.data.actions.create("t1", {
      name: "enrich",
      code: CODE,
      secrets: [{ name: "API_KEY", value: "s3cr3t" }],
    });

    const stored = await rawActionSecrets(created.id);
    expect(stored[0]!.name).toBe("API_KEY");
    expect(stored[0]!.value).toMatch(/^enc:v1:/);
    expect(stored[0]!.value).not.toContain("s3cr3t");

    expect((await ctx.data.actions.get("t1", created.id))?.secrets).toEqual([
      { name: "API_KEY", value: "s3cr3t" },
    ]);
    expect((await ctx.data.actions.list("t1")).actions[0]?.secrets).toEqual([
      { name: "API_KEY", value: "s3cr3t" },
    ]);
  });

  it("reads legacy plaintext action secrets and encrypts them on the next write", async () => {
    const created = await ctx.raw.actions.create("t1", {
      name: "legacy",
      code: CODE,
      secrets: [{ name: "OLD", value: "plain" }],
    });
    expect((await rawActionSecrets(created.id))[0]!.value).toBe("plain");
    expect(
      (await ctx.data.actions.get("t1", created.id))?.secrets?.[0]?.value,
    ).toBe("plain");

    await ctx.data.actions.update("t1", created.id, {
      secrets: [{ name: "OLD", value: "plain" }],
    });
    expect((await rawActionSecrets(created.id))[0]!.value).toMatch(/^enc:v1:/);
  });

  it("keeps a stored secret when an update omits its value", async () => {
    const created = await ctx.data.actions.create("t1", {
      name: "keep",
      code: CODE,
      secrets: [{ name: "KEEP", value: "stay" }],
    });
    await ctx.data.actions.update("t1", created.id, {
      secrets: [{ name: "KEEP" }, { name: "NEW", value: "added" }],
    });
    const read = await ctx.data.actions.get("t1", created.id);
    expect(
      Object.fromEntries(read!.secrets!.map((s) => [s.name, s.value])),
    ).toEqual({ KEEP: "stay", NEW: "added" });
  });

  it("does not double-encrypt a value that is already ciphertext", async () => {
    const created = await ctx.data.actions.create("t1", {
      name: "twice",
      code: CODE,
      secrets: [{ name: "A", value: "v" }],
    });
    const [first] = await rawActionSecrets(created.id);
    await ctx.data.actions.update("t1", created.id, {
      secrets: [{ name: "A", value: first!.value }],
    });
    expect((await rawActionSecrets(created.id))[0]!.value).toBe(first!.value);
  });

  it("encrypts hook_code secrets at rest and decrypts on get", async () => {
    const created = await ctx.data.hookCode.create("t1", {
      code: CODE,
      secrets: { TOKEN: "hook-secret" },
    });
    const row = await ctx.db
      .selectFrom("hook_code")
      .select("secrets")
      .where("id", "=", created.id)
      .executeTakeFirst();
    const stored = JSON.parse(row!.secrets!) as Record<string, string>;
    expect(stored.TOKEN).toMatch(/^enc:v1:/);
    expect(stored.TOKEN).not.toContain("hook-secret");

    expect((await ctx.data.hookCode.get("t1", created.id))?.secrets).toEqual({
      TOKEN: "hook-secret",
    });

    await ctx.data.hookCode.update("t1", created.id, {
      secrets: { TOKEN: "rotated" },
    });
    expect((await ctx.data.hookCode.get("t1", created.id))?.secrets).toEqual({
      TOKEN: "rotated",
    });
  });

  it("tags control-plane secrets with a separate key id", async () => {
    const tenantKey = await randomKey();
    const cpKey = await randomKey();
    const ring = { default: tenantKey, keys: { cp: cpKey } };
    const data = createEncryptedDataAdapterWithKeyRing(ctx.raw, ring, {
      resolveEncryptKeyId: (tenantId) => (tenantId === "cp" ? "cp" : undefined),
    });

    const created = await data.actions.create("cp", {
      name: "platform",
      code: CODE,
      secrets: [{ name: "S", value: "shh" }],
    });
    expect((await rawActionSecrets(created.id))[0]!.value).toMatch(
      /^enc:v1:cp:/,
    );

    // A tenant without the cp key cannot read it.
    const withoutCp = createEncryptedDataAdapterWithKeyRing(
      ctx.raw,
      { default: tenantKey },
      { resolveEncryptKeyId: () => undefined },
    );
    await expect(withoutCp.actions.get("cp", created.id)).rejects.toThrow(
      /No key for id "cp"/,
    );
    expect(
      (await data.actions.get("cp", created.id))?.secrets?.[0]?.value,
    ).toBe("shh");
  });
});

describe("canDecrypt", () => {
  it("accepts plaintext and ciphertext the ring can read, rejects the rest", async () => {
    const a = await randomKey();
    const b = await randomKey();
    const ring = { default: a, keys: { cp: b } };

    const defaultCipher = await encryptFieldWithRing("x", ring);
    const cpCipher = await encryptFieldWithRing("x", ring, "cp");

    expect(await canDecrypt("plain", ring)).toBe(true);
    expect(await canDecrypt(defaultCipher, ring)).toBe(true);
    expect(await canDecrypt(cpCipher, ring)).toBe(true);

    // Key id missing from the ring.
    expect(await canDecrypt(cpCipher, { default: a })).toBe(false);
    // Key id present but it is a different key.
    expect(await canDecrypt(cpCipher, { default: a, keys: { cp: a } })).toBe(
      false,
    );
    // Default-key ciphertext under a different default key.
    expect(await canDecrypt(defaultCipher, { default: b })).toBe(false);
  });
});
