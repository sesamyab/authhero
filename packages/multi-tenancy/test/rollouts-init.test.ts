import { describe, it, expect, beforeEach } from "vitest";
import createAdapters from "@authhero/kysely-adapter";
import { encodeBase64Url } from "@authhero/adapter-interfaces";
import { init } from "authhero";
import { initMultiTenant } from "../src/init";
import {
  advanceRollout,
  advanceRollouts,
  reconcileConfigDrift,
  type RolloutDeps,
} from "../src";
import { createMigratedDb } from "./helpers/migrated-db";

const CONTROL_PLANE = "control_plane";
const CHILD = "acme";
const ISSUER = "https://auth.example.com/";
const MANAGEMENT_AUDIENCE = "urn:authhero:management";

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

async function signRs256(
  pkcs8Pem: string,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * initMultiTenant wires the rollout controller, the write trigger and the
 * deps a scheduled handler ticks, so a fleet can be rolled out end to end
 * through the management API.
 */
describe("initMultiTenant fleet rollouts", () => {
  let request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>;
  let adapters: ReturnType<typeof createAdapters>;
  let rollouts: RolloutDeps;

  beforeEach(async () => {
    adapters = createAdapters(await createMigratedDb());
    for (const id of [CONTROL_PLANE, "a", "b", "c"]) {
      await adapters.tenants.create({
        id,
        friendly_name: id,
        audience: `https://${id}.example.com`,
        sender_email: "admin@example.com",
        sender_name: id,
        ...(id === CONTROL_PLANE ? {} : { config_sync: "synced" as const }),
      });
    }
    await adapters.actions.create(CONTROL_PLANE, {
      name: "enrich",
      code: "exports.onExecutePostLogin = async () => {};",
      scope: "shared",
    });

    const { createX509Certificate } = init({ dataAdapter: adapters });
    const signingKey = await createX509Certificate({ name: "CN=test" });
    await adapters.keys.create({ ...signingKey, type: "jwt_signing" });

    const result = initMultiTenant({
      dataAdapter: adapters,
      controlPlane: {
        tenantId: CONTROL_PLANE,
        clientId: "control-plane-client",
      },
    });
    rollouts = result.rollouts!;

    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256(signingKey.pkcs7!, signingKey.kid, {
      iss: ISSUER,
      aud: MANAGEMENT_AUDIENCE,
      sub: "admin",
      tenant_id: CONTROL_PLANE,
      permissions: [
        "read:rollouts",
        "create:rollouts",
        "update:rollouts",
        "read:tenant_operations",
        "create:actions",
        "update:actions",
      ],
      iat: now,
      exp: now + 3600,
    });
    const env = {
      ISSUER,
      AUTH_URL: "https://auth.example.com",
      ENVIRONMENT: "test",
    };
    request = (method, path, body) =>
      app_request(result.app, method, path, token, env, body);
  });

  async function json(response: Response) {
    return response.json() as Promise<any>;
  }

  it("exposes the deps a scheduled handler needs", () => {
    expect(rollouts.controlPlaneTenantId).toBe(CONTROL_PLANE);
    expect(rollouts.executor.engine).toBe("inline");
  });

  it("creates a rollout, starts its canary, reports progress, and finishes on ticks", async () => {
    const response = await request("POST", "/api/v2/rollouts", {
      canary: 1,
      waves: [100],
    });
    expect(response.status).toBe(201);
    const rollout = await json(response);
    expect(rollout).toMatchObject({ kind: "config-sync", status: "canary" });

    let detail = await json(
      await request("GET", `/api/v2/rollouts/${rollout.id}`),
    );
    expect(detail.summary.total).toBe(3);
    expect(detail.summary.by_wave).toEqual([
      expect.objectContaining({ wave: 0, total: 1 }),
      expect.objectContaining({ wave: 1, total: 2 }),
    ]);
    expect(detail.summary.by_status.succeeded).toBe(1);

    await advanceRollouts(rollouts);
    await advanceRollouts(rollouts);

    detail = await json(await request("GET", `/api/v2/rollouts/${rollout.id}`));
    expect(detail.status).toBe("done");
    expect(detail.summary.by_status).toEqual({ succeeded: 3 });

    const listed = await json(
      await request("GET", "/api/v2/rollouts?status=done"),
    );
    expect(listed.rollouts.map((r: { id: string }) => r.id)).toContain(
      rollout.id,
    );

    const history = await json(
      await request(
        "GET",
        `/api/v2/tenants/a/operations?rollout_id=${rollout.id}`,
      ),
    );
    expect(history.operations).toHaveLength(1);
    expect(history.operations[0]).toMatchObject({
      kind: "sync-defaults",
      rollout_id: rollout.id,
    });
  });

  it("pauses and resumes through the API", async () => {
    const rollout = await json(
      await request("POST", "/api/v2/rollouts", { canary: 1, waves: [100] }),
    );

    const paused = await json(
      await request("POST", `/api/v2/rollouts/${rollout.id}/pause`, {
        reason: "hold on",
      }),
    );
    expect(paused).toMatchObject({
      status: "paused",
      paused_reason: "hold on",
    });

    await advanceRollouts(rollouts);
    let detail = await json(
      await request("GET", `/api/v2/rollouts/${rollout.id}`),
    );
    expect(detail.summary.by_status.pending).toBe(2);

    const resumed = await json(
      await request("POST", `/api/v2/rollouts/${rollout.id}/resume`),
    );
    expect(resumed.status).toBe("rolling");
    await advanceRollouts(rollouts);
    detail = await json(await request("GET", `/api/v2/rollouts/${rollout.id}`));
    expect(detail.summary.by_status.pending ?? 0).toBe(0);
  });

  it("validates the wave plan", async () => {
    expect(
      (await request("POST", "/api/v2/rollouts", { waves: [50, 20] })).status,
    ).toBe(400);
    expect(
      (await request("POST", "/api/v2/rollouts", { failure_threshold: 2 }))
        .status,
    ).toBe(400);
  });

  it("answers 404 for an unknown rollout", async () => {
    expect((await request("GET", "/api/v2/rollouts/nope")).status).toBe(404);
    expect(
      (await request("POST", "/api/v2/rollouts/nope/pause", {})).status,
    ).toBe(404);
  });

  it("turns a published write into one coalesced rollout request, planned after the quiet period", async () => {
    const create = (name: string, scope?: string) =>
      request("POST", "/api/v2/actions/actions", {
        name,
        code: "exports.onExecutePostLogin = async () => {};",
        ...(scope ? { scope } : {}),
      });

    // Not published: no request.
    expect((await create("local-only")).status).toBe(201);
    expect(
      (await adapters.rollouts!.list({ kind: "config-sync" })).rollouts,
    ).toHaveLength(0);

    // Two published writes: one request.
    expect((await create("published-1", "shared")).status).toBe(201);
    expect((await create("published-2", "platform")).status).toBe(201);
    const { rollouts: requested } = await adapters.rollouts!.list({
      kind: "config-sync",
    });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      status: "pending",
      config: {
        trigger: "write",
        origin_tenant_id: CONTROL_PLANE,
        planned: false,
      },
    });

    // Waiting out the debounce plans it.
    expect((await advanceRollout(rollouts, requested[0]!.id)).outcome).toBe(
      "waiting",
    );
    const later = { ...rollouts, now: () => Date.now() + 3_600_000 };
    expect((await advanceRollout(later, requested[0]!.id)).outcome).toBe(
      "started",
    );
    const ops = await adapters.tenantOperations!.list({
      rollout_id: requested[0]!.id,
    });
    expect(ops.operations).toHaveLength(3);
  });

  it("finds what a lost trigger would have rolled out", async () => {
    // Synced once, then the control plane changes with no request recorded.
    const first = await json(
      await request("POST", "/api/v2/rollouts", { canary: 0, waves: [100] }),
    );
    for (let i = 0; i < 3; i++) await advanceRollouts(rollouts);
    expect((await adapters.rollouts!.get(first.id))?.status).toBe("done");

    const [action] = (await adapters.actions.list(CONTROL_PLANE)).actions;
    await adapters.actions.update(CONTROL_PLANE, action!.id, {
      code: "exports.onExecutePostLogin = async () => { /* changed */ };",
    });
    expect(
      (
        await adapters.rollouts!.list({
          kind: "config-sync",
          status: ["pending"],
        })
      ).rollouts,
    ).toHaveLength(0);

    const result = await reconcileConfigDrift(rollouts);
    expect(result.drifted).toBe(3);
    expect(result.rolloutId).toBeTruthy();
    for (let i = 0; i < 4; i++) await advanceRollouts(rollouts);
    expect((await reconcileConfigDrift(rollouts)).drifted).toBe(0);
  });
});

function app_request(
  app: {
    request: (
      path: string,
      init: RequestInit,
      env: unknown,
    ) => Response | Promise<Response>;
  },
  method: string,
  path: string,
  token: string,
  env: unknown,
  body?: unknown,
) {
  return Promise.resolve(
    app.request(
      path,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "tenant-id": CONTROL_PLANE,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
    ),
  );
}
