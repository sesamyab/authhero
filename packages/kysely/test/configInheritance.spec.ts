import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { getTestServer } from "./helpers/test-server";
import * as configInheritance from "../migrate/migrations/2026-10-21T12:00:00_config_inheritance";

const tenantId = "tenantId";

describe("config inheritance columns (kysely)", () => {
  let server: Awaited<ReturnType<typeof getTestServer>>;
  let data: typeof server.data;

  beforeEach(async () => {
    server = await getTestServer();
    data = server.data;
    await data.tenants.create({
      id: tenantId,
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });
  });

  it("leaves fields unset by default", async () => {
    const connection = await data.connections.create(tenantId, {
      id: "c1",
      name: "plain",
      strategy: "mock-strategy",
      options: {},
    });
    const read = await data.connections.get(tenantId, connection.id);
    expect(read?.scope).toBeUndefined();
    expect(read?.override).toBeUndefined();
    expect(read?.enforce).toBeUndefined();
  });

  it("round-trips the tenant parent", async () => {
    await data.tenants.create({
      id: "child",
      friendly_name: "Child",
      audience: "https://child.example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
      parent_tenant_id: tenantId,
    });
    expect((await data.tenants.get("child"))?.parent_tenant_id).toBe(tenantId);
    expect(
      (await data.tenants.get(tenantId))?.parent_tenant_id,
    ).toBeUndefined();
  });

  it("round-trips fields on connections", async () => {
    await data.connections.create(tenantId, {
      id: "c1",
      name: "shared",
      strategy: "mock-strategy",
      options: {},
      scope: "shared",
      override: "secrets",
      enforce: true,
    });
    expect(await data.connections.get(tenantId, "c1")).toMatchObject({
      scope: "shared",
      override: "secrets",
      enforce: true,
    });
    await data.connections.update(tenantId, "c1", {
      scope: "platform",
      enforce: false,
    });
    const listed = (await data.connections.list(tenantId)).connections;
    expect(listed[0]).toMatchObject({
      scope: "platform",
      override: "secrets",
      enforce: false,
    });
  });

  it("round-trips fields on actions", async () => {
    const created = await data.actions.create(tenantId, {
      name: "a",
      code: "exports.onExecutePostLogin = async () => {};",
      scope: "platform",
      override: "none",
      enforce: true,
    });
    expect(await data.actions.get(tenantId, created.id)).toMatchObject({
      scope: "platform",
      override: "none",
      enforce: true,
    });
    await data.actions.update(tenantId, created.id, { enforce: false });
    const listed = (await data.actions.list(tenantId)).actions;
    expect(listed[0]).toMatchObject({ scope: "platform", enforce: false });
  });

  it("round-trips fields on hooks", async () => {
    const created = await data.hooks.create(tenantId, {
      trigger_id: "post-user-login",
      url: "https://example.com/hook",
      scope: "shared",
      override: "fields",
      enforce: true,
    });
    expect(await data.hooks.get(tenantId, created.hook_id)).toMatchObject({
      scope: "shared",
      override: "fields",
      enforce: true,
    });
    await data.hooks.update(tenantId, created.hook_id, { enforce: false });
    const listed = (await data.hooks.list(tenantId)).hooks;
    expect(listed[0]).toMatchObject({ scope: "shared", enforce: false });
  });

  it("round-trips fields on resource servers", async () => {
    await data.resourceServers.create(tenantId, {
      identifier: "https://api.example.com",
      name: "api",
      scope: "shared",
      override: "none",
      enforce: true,
    });
    const [rs] = (await data.resourceServers.list(tenantId)).resource_servers;
    expect(rs).toMatchObject({
      scope: "shared",
      override: "none",
      enforce: true,
    });
    expect(await data.resourceServers.get(tenantId, rs!.id!)).toMatchObject({
      scope: "shared",
      enforce: true,
    });
    await data.resourceServers.update(tenantId, rs!.id!, { enforce: false });
    expect((await data.resourceServers.get(tenantId, rs!.id!))?.enforce).toBe(
      false,
    );
  });

  it("round-trips fields on branding, prompt settings and email providers", async () => {
    await data.branding.set(tenantId, {
      colors: { primary: "#000000" },
      scope: "shared",
      enforce: true,
    });
    expect(await data.branding.get(tenantId)).toMatchObject({
      scope: "shared",
      enforce: true,
    });

    await data.promptSettings.set(tenantId, {
      scope: "shared",
      override: "fields",
      enforce: true,
    });
    expect(await data.promptSettings.get(tenantId)).toMatchObject({
      scope: "shared",
      override: "fields",
      enforce: true,
    });

    await data.emailProviders.create(tenantId, {
      name: "mailgun",
      enabled: true,
      credentials: { api_key: "x" },
      scope: "platform",
      enforce: true,
    });
    expect(await data.emailProviders.get(tenantId)).toMatchObject({
      scope: "platform",
      enforce: true,
    });
  });

  it("backfills scope from is_system and metadata.inheritable", async () => {
    await data.connections.create(tenantId, {
      id: "sys",
      name: "sys",
      strategy: "mock-strategy",
      options: {},
      is_system: true,
    });
    await data.connections.create(tenantId, {
      id: "loc",
      name: "loc",
      strategy: "mock-strategy",
      options: {},
    });
    await data.hooks.create(tenantId, {
      trigger_id: "post-user-login",
      url: "https://example.com/a",
      metadata: { inheritable: true },
    });
    await data.hooks.create(tenantId, {
      trigger_id: "post-user-login",
      url: "https://example.com/b",
      metadata: { inheritable: false },
    });

    // A hook whose metadata was re-serialised with whitespace is still found.
    await data.hooks.create(tenantId, {
      trigger_id: "post-user-login",
      url: "https://example.com/c",
      metadata: { inheritable: true },
    });
    await sql`UPDATE hooks SET metadata = '{ "inheritable": true }' WHERE url LIKE '%/c'`.execute(
      server.db,
    );

    // Re-running up() is safe (columns exist) and performs the backfill.
    await configInheritance.up(server.db as any);

    expect(await data.connections.get(tenantId, "sys")).toMatchObject({
      scope: "shared",
      override: "none",
    });
    expect(
      (await data.connections.get(tenantId, "loc"))?.scope,
    ).toBeUndefined();

    const hooks = (await data.hooks.list(tenantId)).hooks;
    const a = hooks.find((h) => (h as any).url?.endsWith("/a"));
    const b = hooks.find((h) => (h as any).url?.endsWith("/b"));
    expect(a?.scope).toBe("shared");
    expect(b?.scope).toBeUndefined();
    const c = hooks.find((h) => (h as any).url?.endsWith("/c"));
    expect(c?.scope).toBe("shared");
  });

  it("round-trips the config sync hash on the tenant", async () => {
    expect(
      (await data.tenants.get(tenantId))?.config_sync_hash,
    ).toBeUndefined();
    await data.tenants.update(tenantId, {
      config_sync_hash: "abc",
      config_synced_at: "2026-10-26T00:00:00.000Z",
    });
    expect(await data.tenants.get(tenantId)).toMatchObject({
      config_sync_hash: "abc",
      config_synced_at: "2026-10-26T00:00:00.000Z",
    });
  });
});
