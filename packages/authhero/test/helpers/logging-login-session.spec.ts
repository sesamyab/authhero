import { describe, it, expect } from "vitest";
import { LogTypes } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";
import { logMessage } from "../../src/helpers/logging";

function makeCtx(env: any, vars: Record<string, unknown>): any {
  return {
    env,
    var: { ip: "1.2.3.4", useragent: "vitest", client_id: "clientId", ...vars },
    set: () => {},
    req: {
      method: "GET",
      path: "/u/login/identifier",
      queries: () => ({}),
      raw: { headers: new Headers() },
    },
  };
}

async function lastLog(env: any) {
  const { logs } = await env.data.logs.list("tenantId", {
    page: 0,
    per_page: 50,
    include_totals: true,
  });
  return logs.find((l: any) => l.description === "probe");
}

describe("logMessage login_session_id", () => {
  it("defaults to the request's login session", async () => {
    const { env } = await getTestServer();
    await logMessage(
      makeCtx(env, { loginSession: { id: "ls_ctx" } }),
      "tenantId",
      {
        type: LogTypes.INFORMATION,
        description: "probe",
        waitForCompletion: true,
      },
    );
    expect((await lastLog(env)).details.login_session_id).toBe("ls_ctx");
  });

  it("lets an explicit login_session_id win", async () => {
    const { env } = await getTestServer();
    await logMessage(
      makeCtx(env, { loginSession: { id: "ls_ctx" } }),
      "tenantId",
      {
        type: LogTypes.INFORMATION,
        description: "probe",
        login_session_id: "ls_explicit",
        waitForCompletion: true,
      },
    );
    expect((await lastLog(env)).details.login_session_id).toBe("ls_explicit");
  });

  it("adds nothing when there is no login session", async () => {
    const { env } = await getTestServer();
    await logMessage(makeCtx(env, {}), "tenantId", {
      type: LogTypes.INFORMATION,
      description: "probe",
      waitForCompletion: true,
    });
    expect((await lastLog(env)).details).not.toHaveProperty("login_session_id");
  });

  it("keeps custom details and still adds the id", async () => {
    const { env } = await getTestServer();
    await logMessage(
      makeCtx(env, { loginSession: { id: "ls_ctx" } }),
      "tenantId",
      {
        type: LogTypes.INFORMATION,
        description: "probe",
        details: { foo: "bar" },
        waitForCompletion: true,
      },
    );
    const log = await lastLog(env);
    expect(log.details).toMatchObject({
      foo: "bar",
      login_session_id: "ls_ctx",
    });
  });
});
