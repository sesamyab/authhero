import { describe, it, expect, beforeEach } from "vitest";
import { getTestServer } from "../helpers/test-server";

const device = {
  last_ip: "",
  initial_ip: "",
  last_user_agent: "",
  initial_user_agent: "",
  initial_asn: "",
  last_asn: "",
};

describe("sessions adapter authentication record (#1668)", () => {
  let data: ReturnType<typeof getTestServer>["data"];

  beforeEach(async () => {
    data = getTestServer().data;
    await data.tenants.create({ id: "tenantId", name: "Test Tenant" });
  });

  it("reads back no authentication for a session that never did MFA", async () => {
    await data.sessions.create("tenantId", {
      id: "plain",
      user_id: "email|userId",
      login_session_id: "loginSessionId",
      device,
      clients: ["clientId"],
    });

    const session = await data.sessions.get("tenantId", "plain");
    expect(session?.authentication).toBeUndefined();
  });

  it("round-trips authentication through create, update, get and list", async () => {
    const created = {
      methods: [
        { name: "mfa", type: "phone", timestamp: "2026-11-05T11:00:00.000Z" },
      ],
    };
    await data.sessions.create("tenantId", {
      id: "mfa",
      user_id: "email|userId",
      login_session_id: "loginSessionId",
      device,
      clients: ["clientId"],
      authentication: created,
    });
    expect(
      (await data.sessions.get("tenantId", "mfa"))?.authentication,
    ).toEqual(created);

    const updated = {
      methods: [
        ...created.methods,
        { name: "mfa", type: "totp", timestamp: "2026-11-05T12:00:00.000Z" },
      ],
    };
    await data.sessions.update("tenantId", "mfa", { authentication: updated });
    expect(
      (await data.sessions.get("tenantId", "mfa"))?.authentication,
    ).toEqual(updated);

    const { sessions } = await data.sessions.list("tenantId");
    expect(sessions.find((s) => s.id === "mfa")?.authentication).toEqual(
      updated,
    );
  });
});
