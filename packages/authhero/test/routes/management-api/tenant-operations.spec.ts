import { describe, it, expect } from "vitest";
import { createToken, getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import type { TenantOperationExecutorBinding } from "../../../src/types";

// Driven through the full `app` (management API at /api/v2) so the parent
// onError resolves 5xx responses, mirroring tenant-redeploy.spec.ts.

// Stub executor backed by the test server's own adapters: creates the row,
// records one event, and finalizes — modelling the inline engine's
// "terminal before resolve" contract without importing multi-tenancy.
function createStubExecutor(getData: () => DataAdapters | undefined) {
  const executor: TenantOperationExecutorBinding = {
    engine: "inline",
    async enqueue(params) {
      const data = getData();
      if (!data?.tenantOperations || !data.tenantOperationEvents) {
        throw new Error("stub executor: operations adapters missing");
      }
      const created = await data.tenantOperations.create({
        tenant_id: params.tenant_id,
        kind: params.kind,
        engine: "inline",
        initiated_by: params.initiated_by,
      });
      await data.tenantOperationEvents.create({
        operation_id: created.id,
        step: params.kind,
        outcome: "succeeded",
      });
      await data.tenantOperations.update(created.id, {
        status: "succeeded",
        finished_at: new Date().toISOString(),
      });
      const finished = await data.tenantOperations.get(created.id);
      if (!finished) throw new Error("stub executor: operation vanished");
      return finished;
    },
  };
  return executor;
}

describe("management-api tenant operations", () => {
  it("lists an empty history for a fresh tenant", async () => {
    const { app, env } = await getTestServer();
    const token = await getAdminToken();

    const response = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operations: [],
      start: 0,
      limit: 50,
      length: 0,
    });
  });

  it("enqueues an upgrade and exposes it via GET /operations/{id}", async () => {
    const dataRef: { current?: DataAdapters } = {};
    const { app, env } = await getTestServer({
      tenantOperationExecutor: createStubExecutor(() => dataRef.current),
    });
    dataRef.current = env.data;

    const token = await getAdminToken();
    const response = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "upgrade" }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const operation = await response.json();
    expect(operation).toMatchObject({
      tenant_id: "tenantId",
      kind: "upgrade",
      status: "succeeded",
      engine: "inline",
    });

    const detailResponse = await app.request(
      `/api/v2/operations/${operation.id}`,
      {
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
        },
      },
      env,
    );
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.id).toBe(operation.id);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({
      step: "upgrade",
      outcome: "succeeded",
    });

    const listResponse = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
        },
      },
      env,
    );
    const list = await listResponse.json();
    expect(list.operations).toHaveLength(1);
    expect(list.operations[0].id).toBe(operation.id);
  });

  it("rejects lifecycle-managed kinds with 400", async () => {
    const dataRef: { current?: DataAdapters } = {};
    const { app, env } = await getTestServer({
      tenantOperationExecutor: createStubExecutor(() => dataRef.current),
    });
    dataRef.current = env.data;

    const token = await getAdminToken();
    const response = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "provision" }),
      },
      env,
    );

    expect(response.status).toBe(400);
  });

  it("returns 501 for not-yet-supported kinds", async () => {
    const dataRef: { current?: DataAdapters } = {};
    const { app, env } = await getTestServer({
      tenantOperationExecutor: createStubExecutor(() => dataRef.current),
    });
    dataRef.current = env.data;

    const token = await getAdminToken();
    const response = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "backup" }),
      },
      env,
    );

    expect(response.status).toBe(501);
  });

  describe("sync-defaults", () => {
    async function setupSync(kinds?: TenantOperationExecutorBinding["kinds"]) {
      const dataRef: { current?: DataAdapters } = {};
      const seen: unknown[] = [];
      const stub = createStubExecutor(() => dataRef.current);
      const executor: TenantOperationExecutorBinding = {
        ...stub,
        ...(kinds ? { kinds } : {}),
        async enqueue(params) {
          seen.push(params);
          return stub.enqueue(params);
        },
      };
      const { app, env } = await getTestServer({
        tenantOperationExecutor: executor,
      });
      dataRef.current = env.data;
      const token = await getAdminToken();
      const post = (body: unknown) =>
        app.request(
          "/api/v2/tenants/tenantId/operations",
          {
            method: "POST",
            headers: {
              "tenant-id": "tenantId",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
          env,
        );
      return { post, seen };
    }

    it("passes dry_run, force and prune on as the operation input", async () => {
      const { post, seen } = await setupSync();

      const response = await post({
        kind: "sync-defaults",
        input: { dry_run: true, force: true, prune: true },
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ kind: "sync-defaults" });
      expect(seen).toEqual([
        expect.objectContaining({
          kind: "sync-defaults",
          tenant_id: "tenantId",
          input: { dry_run: true, force: true, prune: true },
        }),
      ]);
    });

    it("takes the same input for a detach, with clean", async () => {
      const { post, seen } = await setupSync();

      const response = await post({
        kind: "detach",
        input: { dry_run: true, clean: true },
      });

      expect(response.status).toBe(201);
      expect(seen[0]).toMatchObject({
        kind: "detach",
        input: { dry_run: true, clean: true },
      });
    });

    it("accepts a sync without input", async () => {
      const { post, seen } = await setupSync();

      expect((await post({ kind: "sync-defaults" })).status).toBe(201);
      expect(seen[0]).not.toHaveProperty("input");
    });

    it("rejects input for other kinds", async () => {
      const { post } = await setupSync();

      const response = await post({
        kind: "upgrade",
        input: { dry_run: true },
      });

      expect(response.status).toBe(400);
    });

    it("rejects unknown input fields", async () => {
      const { post } = await setupSync();

      expect(
        (await post({ kind: "sync-defaults", input: { dry_run: "yes" } }))
          .status,
      ).toBe(400);
    });

    it("answers 501 for a kind the executor does not run", async () => {
      const { post, seen } = await setupSync(["sync-defaults"]);

      expect((await post({ kind: "upgrade" })).status).toBe(501);
      expect(seen).toEqual([]);
      expect((await post({ kind: "sync-defaults" })).status).toBe(201);
    });
  });

  it("returns 501 when no executor is configured", async () => {
    const { app, env } = await getTestServer();

    const token = await getAdminToken();
    const response = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "upgrade" }),
      },
      env,
    );

    expect(response.status).toBe(501);
  });

  it("returns 403 when the caller is not the control plane", async () => {
    const dataRef: { current?: DataAdapters } = {};
    const { app, env } = await getTestServer({
      tenantOperationExecutor: createStubExecutor(() => dataRef.current),
    });
    dataRef.current = env.data;

    env.data.multiTenancyConfig = {
      controlPlaneTenantId: "control_plane",
    };

    const token = await getAdminToken();
    const response = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "upgrade" }),
      },
      env,
    );

    expect(response.status).toBe(403);
  });

  it("hides other tenants' operations from non-control-plane callers", async () => {
    const { app, env } = await getTestServer();

    // Designate a control plane BEFORE any request — the management app
    // wraps the data adapter on first use, so a later mutation isn't seen
    // (same constraint as the redeploy 403 test).
    env.data.multiTenancyConfig = {
      controlPlaneTenantId: "control_plane",
    };

    // Seed the operation directly: POST is control-plane-only, and the
    // acting tenants in this test deliberately aren't the control plane.
    await env.data.tenants.create({
      id: "otherTenant",
      friendly_name: "Other Tenant",
    });
    const operation = await env.data.tenantOperations!.create({
      tenant_id: "tenantId",
      kind: "upgrade",
      engine: "inline",
    });

    const token = await getAdminToken();

    // A foreign tenant gets a 404 for the operation and a 403 for the list.
    const foreignGet = await app.request(
      `/api/v2/operations/${operation.id}`,
      {
        headers: {
          "tenant-id": "otherTenant",
          authorization: `Bearer ${token}`,
        },
      },
      env,
    );
    expect(foreignGet.status).toBe(404);

    const foreignList = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        headers: {
          "tenant-id": "otherTenant",
          authorization: `Bearer ${token}`,
        },
      },
      env,
    );
    expect(foreignList.status).toBe(403);

    // The owning tenant can still read its own history.
    const ownGet = await app.request(
      `/api/v2/operations/${operation.id}`,
      {
        headers: { "tenant-id": "tenantId", authorization: `Bearer ${token}` },
      },
      env,
    );
    expect(ownGet.status).toBe(200);
  });

  it("returns 404 for an unknown operation id", async () => {
    const { app, env } = await getTestServer();
    const token = await getAdminToken();

    const response = await app.request(
      "/api/v2/operations/op_does_not_exist",
      {
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
        },
      },
      env,
    );

    expect(response.status).toBe(404);
  });

  it("rejects tokens without the tenant_operations scopes", async () => {
    const { app, env } = await getTestServer();
    const token = await createToken({ permissions: ["read:users"] });

    const response = await app.request(
      "/api/v2/tenants/tenantId/operations",
      {
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${token}`,
        },
      },
      env,
    );

    expect(response.status).toBe(403);
  });
});

// On the control plane the routes must not hand every control-plane token
// every tenant's operations: operators (admin:organizations or a machine
// token) reach all tenants, anyone else only the tenants whose organization
// they belong to, and the narrow retry scope may only retry a failed provision.
describe("management-api tenant operations: who reaches which tenant", () => {
  const CONTROL_PLANE = "tenantId";
  const CHILD = "child";
  const MEMBER = "auth2|member";
  const OUTSIDER = "auth2|outsider";

  async function setup() {
    const dataRef: { current?: DataAdapters } = {};
    const { app, env } = await getTestServer({
      tenantOperationExecutor: createStubExecutor(() => dataRef.current),
    });
    dataRef.current = env.data;
    env.data.multiTenancyConfig = { controlPlaneTenantId: CONTROL_PLANE };

    await env.data.tenants.create({
      id: CHILD,
      friendly_name: "Child",
      audience: "https://child.example.com",
      sender_email: "support@child.example.com",
      sender_name: "Child",
      provisioning_state: "failed",
    });
    const org = await env.data.organizations.create(CONTROL_PLANE, {
      name: CHILD,
    });
    await env.data.users.create(CONTROL_PLANE, {
      user_id: MEMBER,
      email: "member@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });
    await env.data.userOrganizations.create(CONTROL_PLANE, {
      user_id: MEMBER,
      organization_id: org.id,
    });
    const operation = await env.data.tenantOperations!.create({
      tenant_id: CHILD,
      kind: "upgrade",
      engine: "inline",
    });
    return { app, env, operation };
  }

  const get = (
    app: Awaited<ReturnType<typeof setup>>["app"],
    env: unknown,
    path: string,
    token: string,
  ) =>
    app.request(
      path,
      {
        headers: {
          "tenant-id": CONTROL_PLANE,
          authorization: `Bearer ${token}`,
        },
      },
      env as never,
    );

  const post = (
    app: Awaited<ReturnType<typeof setup>>["app"],
    env: unknown,
    token: string,
    kind = "upgrade",
  ) =>
    app.request(
      `/api/v2/tenants/${CHILD}/operations`,
      {
        method: "POST",
        headers: {
          "tenant-id": CONTROL_PLANE,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind }),
      },
      env as never,
    );

  const reader = (user_id: string) =>
    createToken({
      user_id,
      aud: "urn:authhero:management",
      permissions: ["read:tenant_operations"],
    });

  it("hides a tenant's history from a user who is not a member of it", async () => {
    const { app, env } = await setup();
    const response = await get(
      app,
      env,
      `/api/v2/tenants/${CHILD}/operations`,
      await reader(OUTSIDER),
    );
    expect(response.status).toBe(404);
  });

  it("shows a tenant's history to a member of it", async () => {
    const { app, env, operation } = await setup();
    const response = await get(
      app,
      env,
      `/api/v2/tenants/${CHILD}/operations`,
      await reader(MEMBER),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).operations[0].id).toBe(operation.id);
  });

  it("answers 404 for an operation of a tenant the user is not a member of", async () => {
    const { app, env, operation } = await setup();
    const outsider = await get(
      app,
      env,
      `/api/v2/operations/${operation.id}`,
      await reader(OUTSIDER),
    );
    expect(outsider.status).toBe(404);
    const member = await get(
      app,
      env,
      `/api/v2/operations/${operation.id}`,
      await reader(MEMBER),
    );
    expect(member.status).toBe(200);
  });

  it("lets a global operator and a machine token reach any tenant", async () => {
    const { app, env, operation } = await setup();
    const operator = await createToken({
      user_id: OUTSIDER,
      aud: "urn:authhero:management",
      permissions: ["read:tenant_operations", "admin:organizations"],
    });
    expect(
      (await get(app, env, `/api/v2/operations/${operation.id}`, operator))
        .status,
    ).toBe(200);

    const machine = await createToken({
      user_id: "client@clients",
      azp: "client",
      aud: "urn:authhero:management",
      permissions: ["read:tenant_operations"],
    });
    expect(
      (await get(app, env, `/api/v2/operations/${operation.id}`, machine))
        .status,
    ).toBe(200);
  });

  it("does not take a control-plane token for the child's own caller when it names the child in tenant-id", async () => {
    const { app, env, operation } = await setup();
    const asChild = (token: string, path: string) =>
      app.request(
        path,
        {
          headers: { "tenant-id": CHILD, authorization: `Bearer ${token}` },
        },
        env as never,
      );
    const controlPlaneToken = (user_id: string) =>
      createToken({
        user_id,
        tenant_id: CONTROL_PLANE,
        aud: "urn:authhero:management",
        permissions: ["read:tenant_operations"],
      });

    const outsider = await controlPlaneToken(OUTSIDER);
    expect(
      (await asChild(outsider, `/api/v2/tenants/${CHILD}/operations`)).status,
    ).toBe(404);
    expect(
      (await asChild(outsider, `/api/v2/operations/${operation.id}`)).status,
    ).toBe(404);

    const member = await controlPlaneToken(MEMBER);
    expect(
      (await asChild(member, `/api/v2/tenants/${CHILD}/operations`)).status,
    ).toBe(200);
    expect(
      (await asChild(member, `/api/v2/operations/${operation.id}`)).status,
    ).toBe(200);
  });

  it("treats holders of the operator scopes as reaching every tenant", async () => {
    const { app, env, operation } = await setup();
    for (const scope of ["create:tenant_operations", "create:rollouts"]) {
      const token = await createToken({
        user_id: OUTSIDER,
        aud: "urn:authhero:management",
        permissions: ["read:tenant_operations", scope],
      });
      expect(
        (await get(app, env, `/api/v2/operations/${operation.id}`, token))
          .status,
      ).toBe(200);
    }
  });

  it("does not let an organization-scoped admin:organizations act globally", async () => {
    const { app, env, operation } = await setup();
    const token = await createToken({
      user_id: OUTSIDER,
      aud: "urn:authhero:management",
      org_id: "org_other",
      permissions: ["read:tenant_operations", "admin:organizations"],
    });
    expect(
      (await get(app, env, `/api/v2/operations/${operation.id}`, token)).status,
    ).toBe(404);
  });

  describe("retry:tenant_provisioning", () => {
    const retrier = (user_id: string) =>
      createToken({
        user_id,
        aud: "urn:authhero:management",
        permissions: ["retry:tenant_provisioning"],
      });

    it("lets a member retry a failed provision with an upgrade", async () => {
      const { app, env } = await setup();
      const response = await post(app, env, await retrier(MEMBER));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        tenant_id: CHILD,
        kind: "upgrade",
      });
    });

    it("reads the grants the way the authentication middleware does", async () => {
      const { app, env } = await setup();
      // `scope` as an array, with the retry scope only.
      const arrayScope = await createToken({
        user_id: MEMBER,
        aud: "urn:authhero:management",
        scope: ["retry:tenant_provisioning"] as unknown as string,
      });
      expect((await post(app, env, arrayScope)).status).toBe(201);

      // The reversed spelling of the operator scope still counts as one, so
      // it may upgrade a tenant that did not fail.
      await env.data.tenants.update(CHILD, { provisioning_state: "ready" });
      const reversed = await createToken({
        user_id: "client@clients",
        azp: "client",
        aud: "urn:authhero:management",
        permissions: ["tenant_operations:create"],
      });
      expect((await post(app, env, reversed)).status).toBe(201);
    });

    it("refuses every other kind", async () => {
      const { app, env } = await setup();
      for (const kind of ["sync-defaults", "detach"]) {
        const response = await post(app, env, await retrier(MEMBER), kind);
        expect(response.status).toBe(403);
      }
    });

    it("refuses a tenant that did not fail", async () => {
      const { app, env } = await setup();
      await env.data.tenants.update(CHILD, { provisioning_state: "ready" });
      const response = await post(app, env, await retrier(MEMBER));
      expect(response.status).toBe(403);
    });

    it("answers 404 for a user who is not a member of the tenant", async () => {
      const { app, env } = await setup();
      const response = await post(app, env, await retrier(OUTSIDER));
      expect(response.status).toBe(404);
    });

    it("keeps create:tenant_operations as the operator scope for every kind", async () => {
      const { app, env } = await setup();
      await env.data.tenants.update(CHILD, { provisioning_state: "ready" });
      const operator = await createToken({
        user_id: "client@clients",
        azp: "client",
        aud: "urn:authhero:management",
        permissions: ["create:tenant_operations"],
      });
      const response = await post(app, env, operator);
      expect(response.status).toBe(201);
    });
  });
});
