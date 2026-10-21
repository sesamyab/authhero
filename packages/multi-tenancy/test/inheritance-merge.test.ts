import { describe, expect, it } from "vitest";
import { resolveTenantChain } from "../src/inheritance/chain";
import { effectiveScope, mergeConfig } from "../src/inheritance/merge";
import { ConfigRows, emptyConfigRows } from "../src/inheritance/types";

const rows = (partial: Partial<ConfigRows>): ConfigRows => ({
  ...emptyConfigRows(),
  ...partial,
});

const google = (over: Record<string, unknown> = {}) =>
  ({
    id: "c",
    name: "google",
    strategy: "google-oauth2",
    options: {},
    ...over,
  }) as any;

describe("resolveTenantChain", () => {
  const tenants: Record<string, string | null> = {
    leaf: "mid",
    mid: "root",
    root: null,
    orphan: null,
    deep3: "deep2",
    deep2: "deep1",
    deep1: "deep0",
    deep0: null,
    a: "b",
    b: "a",
  };
  const getTenant = async (id: string) =>
    id in tenants ? { id, parent_tenant_id: tenants[id] } : null;

  it("follows parent_tenant_id, nearest first", async () => {
    expect(await resolveTenantChain({ tenantId: "leaf", getTenant })).toEqual([
      "mid",
      "root",
    ]);
  });

  it("falls back to the legacy control plane without a parent", async () => {
    expect(
      await resolveTenantChain({
        tenantId: "orphan",
        getTenant,
        legacyControlPlane: "cp",
      }),
    ).toEqual(["cp"]);
  });

  it("is empty when the tenant opts out", async () => {
    expect(await resolveTenantChain({ tenantId: "orphan", getTenant })).toEqual(
      [],
    );
  });

  it("prefers an explicit parent over the legacy control plane", async () => {
    expect(
      await resolveTenantChain({
        tenantId: "leaf",
        getTenant,
        legacyControlPlane: "cp",
      }),
    ).toEqual(["mid", "root"]);
  });

  it("rejects cycles and chains deeper than the limit", async () => {
    await expect(
      resolveTenantChain({ tenantId: "a", getTenant }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      resolveTenantChain({ tenantId: "deep3", getTenant }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("effectiveScope", () => {
  it("uses legacy semantics when scope is unset", () => {
    expect(effectiveScope("connection", {})).toBe("shared");
    expect(effectiveScope("resourceServer", {})).toBe("local");
    expect(effectiveScope("resourceServer", { is_system: true })).toBe(
      "shared",
    );
    expect(effectiveScope("hook", { metadata: { inheritable: true } })).toBe(
      "shared",
    );
    expect(effectiveScope("branding", {})).toBe("local");
  });

  it("lets an explicit scope win", () => {
    expect(effectiveScope("connection", { scope: "local" })).toBe("local");
    expect(
      effectiveScope("resourceServer", { is_system: true, scope: "platform" }),
    ).toBe("platform");
  });
});

describe("mergeConfig", () => {
  it("lets the tenant win per option when override allows fields", () => {
    const merged = mergeConfig(
      [
        rows({
          connections: [
            google({
              options: { client_id: "cp", client_secret: "cp-secret" },
            }),
          ],
        }),
      ],
      rows({
        connections: [google({ id: "own", options: { client_id: "t" } })],
      }),
    );
    expect(merged.connections).toHaveLength(1);
    expect(merged.connections[0]).toMatchObject({
      id: "own",
      options: { client_id: "t", client_secret: "cp-secret" },
    });
  });

  it("keeps the parent row when override is none", () => {
    const merged = mergeConfig(
      [
        rows({
          connections: [
            google({
              override: "none",
              options: { client_id: "cp", client_secret: "cp-secret" },
            }),
          ],
        }),
      ],
      rows({
        connections: [google({ id: "own", options: { client_id: "t" } })],
      }),
    );
    expect(merged.connections[0]!.options).toMatchObject({ client_id: "cp" });
  });

  it("lets a child supply only secrets when override is secrets", () => {
    const merged = mergeConfig(
      [
        rows({
          connections: [
            google({
              override: "secrets",
              options: { client_id: "cp", client_secret: "cp-secret" },
            }),
          ],
        }),
      ],
      rows({
        connections: [
          google({
            id: "own",
            options: { client_id: "t", client_secret: "own-secret" },
          }),
        ],
      }),
    );
    expect(merged.connections[0]!.options).toMatchObject({
      client_id: "cp",
      client_secret: "own-secret",
    });
  });

  it("applies nearest-wins across a two-level chain", () => {
    const merged = mergeConfig(
      [
        rows({
          connections: [
            google({ options: { client_id: "mid", extra: "mid" } }),
          ],
        }),
        rows({
          connections: [
            google({ options: { client_id: "root", other: "root" } }),
          ],
        }),
      ],
      rows({}),
    );
    expect(merged.connections[0]!.options).toMatchObject({
      client_id: "mid",
      extra: "mid",
      other: "root",
    });
  });

  it("does not expose local ancestor rows and flags platform rows", () => {
    const merged = mergeConfig(
      [
        rows({
          connections: [
            google({ scope: "local" }),
            google({ strategy: "github", scope: "platform" }),
          ],
        }),
      ],
      rows({}),
    );
    expect(merged.connections.map((c) => c.strategy)).toEqual(["github"]);
    expect(merged.hidden).toContain("connection:github");
  });

  it("adds hooks up and layers action secrets", () => {
    const merged = mergeConfig(
      [
        rows({
          hooks: [
            {
              hook_id: "h1",
              trigger_id: "post-user-login",
              metadata: { inheritable: true },
            } as any,
          ],
          actions: [
            {
              id: "a1",
              name: "enrich",
              code: "upstream",
              is_system: true,
              secrets: [
                { name: "A", value: "1" },
                { name: "B", value: "2" },
              ],
            } as any,
          ],
        }),
      ],
      rows({
        hooks: [{ hook_id: "h2", trigger_id: "post-user-login" } as any],
        actions: [
          {
            id: "a2",
            name: "enrich",
            code: "stub",
            inherit: true,
            secrets: [{ name: "B", value: "own" }],
          } as any,
        ],
      }),
    );
    expect(merged.hooks.map((h: any) => h.hook_id).sort()).toEqual([
      "h1",
      "h2",
    ]);
    expect(merged.actions).toHaveLength(1);
    expect(merged.actions[0]).toMatchObject({ id: "a2", code: "upstream" });
    expect(
      Object.fromEntries(
        merged.actions[0]!.secrets!.map((s) => [s.name, s.value]),
      ),
    ).toEqual({ A: "1", B: "own" });
  });

  it("falls back to the nearest shared singleton", () => {
    const merged = mergeConfig(
      [
        rows({
          emailProvider: { name: "mailgun", credentials: {} } as any,
        }),
      ],
      rows({}),
    );
    expect(merged.emailProvider).toMatchObject({ name: "mailgun" });
  });
});
