/** Local, in-memory server for the RFC 8628 Playwright tests. No OIDF stack needed. */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Kysely, SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createAdapters, {
  migrateToLatest,
  type Database,
} from "@authhero/kysely-adapter";
import { init } from "authhero";
import type { Bindings } from "../../src/types";

const port = Number(process.env.DEVICE_FLOW_TEST_PORT || 3100);
const issuer = `http://localhost:${port}/`;
const db = new Kysely<Database>({
  dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
});
await migrateToLatest(db, false);
const data = createAdapters(db);
await data.tenants.create({
  id: "device-tests",
  friendly_name: "Device flow tests",
  audience: issuer,
  sender_email: "login@example.com",
  sender_name: "Test",
});
for (const client_id of ["device-client", "other-device-client"]) {
  await data.clients.create("device-tests", {
    client_id,
    name: "Test TV",
    app_type: "native",
    token_endpoint_auth_method: "none",
    grant_types: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    client_metadata: {
      universal_login_version: "2",
      email_validation: "disabled",
    },
  });
}
await data.connections.create("device-tests", {
  id: "database",
  name: "Username-Password-Authentication",
  strategy: "auth0",
  options: {},
});
await data.promptSettings.set("device-tests", { identifier_first: true });
await data.users.create("device-tests", {
  user_id: "auth0|device-user",
  email: "device@example.com",
  email_verified: true,
  name: "Device Tester",
  provider: "auth0",
  connection: "Username-Password-Authentication",
  is_social: false,
});
await data.passwords.create("device-tests", {
  user_id: "auth0|device-user",
  password: await bcrypt.hash("DeviceTest123!", 10),
  algorithm: "bcrypt",
});
const widgetPath = fileURLToPath(
  new URL("../../dist/assets/u/widget", import.meta.url),
);
const { app, createX509Certificate } = init({
  dataAdapter: data,
  widgetHandler: serveStatic({
    root: path.relative(process.cwd(), widgetPath),
    rewriteRequestPath: (p) => p.replace("/u/widget", ""),
  }),
});
await data.keys.create(
  await createX509Certificate({ name: "CN=device-tests" }),
);
const bindings: Bindings = {
  data,
  AUTH_URL: issuer,
  ISSUER: issuer,
  ENVIRONMENT: "test",
  JWKS_CACHE_TIMEOUT_IN_SECONDS: 300,
  ORGANIZATION_NAME: "Device flow tests",
};
const server = serve({
  fetch: (req) => app.fetch(req, bindings),
  port,
  hostname: "localhost",
});
console.log(`Device-flow test server listening at ${issuer}`);
async function shutdown() {
  server.close();
  await db.destroy();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
