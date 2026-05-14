import { describe, it, expect } from "vitest";
import {
  KeysAdapter,
  ListKeysResponse,
  SigningKey,
} from "@authhero/adapter-interfaces";
import {
  resolveSigningKeys,
  resolveSigningKeyMode,
} from "../../src/helpers/signing-keys";

function makeKey(overrides: Partial<SigningKey>): SigningKey {
  return {
    kid: overrides.kid ?? "kid",
    cert: overrides.cert ?? "cert",
    fingerprint: overrides.fingerprint ?? "fp",
    thumbprint: overrides.thumbprint ?? "tp",
    type: overrides.type ?? "jwt_signing",
    ...overrides,
  };
}

// Minimal KeysAdapter that filters in-memory by the lucene-ish q parts the
// helper actually emits: `type:jwt_signing AND tenant_id:X` and
// `type:jwt_signing AND -_exists_:tenant_id`.
function makeKeysAdapter(rows: SigningKey[]): KeysAdapter {
  return {
    create: async () => {},
    update: async () => true,
    list: async (params) => {
      const q = params?.q ?? "";
      const want = (() => {
        if (q.includes("-_exists_:tenant_id")) return "control-plane" as const;
        const m = q.match(/tenant_id:([^\s]+)/);
        return m ? ({ kind: "tenant", id: m[1] } as const) : null;
      })();
      const filtered = rows.filter((row) => {
        if (!want) return true;
        if (want === "control-plane") return !row.tenant_id;
        return row.tenant_id === want.id;
      });
      const response: ListKeysResponse = {
        signingKeys: filtered,
        start: 0,
        limit: filtered.length,
        length: filtered.length,
      };
      return response;
    },
  };
}

describe("resolveSigningKeyMode", () => {
  it("defaults to control-plane when no option is given", async () => {
    expect(await resolveSigningKeyMode(undefined, "t1")).toBe("control-plane");
  });

  it("returns the static value as-is", async () => {
    expect(await resolveSigningKeyMode("tenant", "t1")).toBe("tenant");
  });

  it("invokes the resolver with tenant_id", async () => {
    const seen: string[] = [];
    const result = await resolveSigningKeyMode(({ tenant_id }) => {
      seen.push(tenant_id);
      return tenant_id === "t1" ? "tenant" : "control-plane";
    }, "t1");
    expect(result).toBe("tenant");
    expect(seen).toEqual(["t1"]);
  });
});

describe("resolveSigningKeys (sign purpose)", () => {
  const cpKey = makeKey({ kid: "cp" });
  const t1Key = makeKey({ kid: "t1", tenant_id: "t1" });

  it("returns the control-plane key in control-plane mode", async () => {
    const keys = makeKeysAdapter([cpKey, t1Key]);
    const result = await resolveSigningKeys(keys, "t1", "control-plane", {
      purpose: "sign",
    });
    expect(result.map((k) => k.kid)).toEqual(["cp"]);
  });

  it("prefers the tenant key in tenant mode", async () => {
    const keys = makeKeysAdapter([cpKey, t1Key]);
    const result = await resolveSigningKeys(keys, "t1", "tenant", {
      purpose: "sign",
    });
    expect(result.map((k) => k.kid)).toEqual(["t1"]);
  });

  it("falls back to control-plane when the tenant has no key", async () => {
    const keys = makeKeysAdapter([cpKey]);
    const result = await resolveSigningKeys(keys, "t1", "tenant", {
      purpose: "sign",
    });
    expect(result.map((k) => k.kid)).toEqual(["cp"]);
  });

  it("skips revoked tenant keys when picking", async () => {
    const revoked = makeKey({
      kid: "t1-old",
      tenant_id: "t1",
      revoked_at: new Date(Date.now() - 1000).toISOString(),
    });
    const keys = makeKeysAdapter([cpKey, revoked]);
    const result = await resolveSigningKeys(keys, "t1", "tenant", {
      purpose: "sign",
    });
    expect(result.map((k) => k.kid)).toEqual(["cp"]);
  });

  it("returns nothing when no keys exist anywhere", async () => {
    const keys = makeKeysAdapter([]);
    const result = await resolveSigningKeys(keys, "t1", "tenant", {
      purpose: "sign",
    });
    expect(result).toEqual([]);
  });
});

describe("resolveSigningKeys (publish purpose)", () => {
  const cpKey = makeKey({ kid: "cp" });
  const t1Key = makeKey({ kid: "t1", tenant_id: "t1" });
  const t2Key = makeKey({ kid: "t2", tenant_id: "t2" });

  it("returns only control-plane keys in control-plane mode", async () => {
    const keys = makeKeysAdapter([cpKey, t1Key, t2Key]);
    const result = await resolveSigningKeys(keys, "t1", "control-plane", {
      purpose: "publish",
    });
    expect(result.map((k) => k.kid)).toEqual(["cp"]);
  });

  it("returns tenant ∪ control-plane in tenant mode", async () => {
    const keys = makeKeysAdapter([cpKey, t1Key, t2Key]);
    const result = await resolveSigningKeys(keys, "t1", "tenant", {
      purpose: "publish",
    });
    expect(result.map((k) => k.kid).sort()).toEqual(["cp", "t1"]);
  });

  it("falls back gracefully when tenant has no key (publish = control-plane only)", async () => {
    const keys = makeKeysAdapter([cpKey]);
    const result = await resolveSigningKeys(keys, "t1", "tenant", {
      purpose: "publish",
    });
    expect(result.map((k) => k.kid)).toEqual(["cp"]);
  });
});
