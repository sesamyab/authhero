import { describe, it, expect } from "vitest";
import { AuditEvent } from "@authhero/adapter-interfaces";
import {
  buildRequestAuth,
  requestChannel,
} from "../../src/helpers/request-auth";
import { LogsDestination } from "../../src/helpers/outbox-destinations/logs";

const baseEvent = (actor: AuditEvent["actor"]): AuditEvent =>
  ({
    id: "evt_1",
    tenant_id: "tenant",
    event_type: "user.updated",
    log_type: "sapi",
    category: "admin_action",
    actor,
    target: { type: "user", id: "auth2|target" },
    request: {
      method: "PATCH",
      path: "/api/v2/users/auth2|target",
      ip: "1.1.1.1",
    },
    hostname: "example.com",
    timestamp: new Date().toISOString(),
  }) as AuditEvent;

describe("buildRequestAuth", () => {
  it("includes the user for a user token", () => {
    expect(
      buildRequestAuth({
        type: "admin",
        id: "auth2|admin",
        email: "admin@example.com",
        jti: "jti1",
        scopes: ["update:users"],
      }),
    ).toEqual({
      user: { user_id: "auth2|admin", email: "admin@example.com" },
      strategy: "jwt",
      credentials: { jti: "jti1", scopes: ["update:users"] },
    });
  });

  it("omits the user for an M2M token", () => {
    const auth = buildRequestAuth({
      type: "client_credentials",
      id: "client1",
      client_id: "client1",
      scopes: ["update:users"],
    });
    expect(auth?.user).toBeUndefined();
    expect(auth?.credentials.scopes).toEqual(["update:users"]);
  });

  it("returns undefined without token info", () => {
    expect(buildRequestAuth({ type: "user", id: "u" })).toBeUndefined();
  });
});

describe("LogsDestination", () => {
  it("keeps the target as user_id and puts the actor in details.request.auth", () => {
    const dest = new LogsDestination({} as any);
    const { log } = dest.transform(
      baseEvent({
        type: "admin",
        id: "auth2|admin",
        scopes: ["update:users"],
        jti: "jti1",
      }),
    );
    expect(log.user_id).toBe("auth2|target");
    expect(log.scope).toBeUndefined();
    expect((log.details as any).request.auth.user.user_id).toBe("auth2|admin");
    expect((log.details as any).request.channel).toBe("api");
  });
});

describe("requestChannel", () => {
  it("uses the caller origin or falls back to api", () => {
    expect(requestChannel("https://admin.example.com")).toBe(
      "https://admin.example.com/",
    );
    expect(requestChannel(undefined)).toBe("api");
  });
});
