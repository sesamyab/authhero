import { describe, expect, it } from "vitest";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import {
  authErrors,
  conflict,
  formatValidationMessage,
  managementValidationHook,
  notFound,
} from "../../src/errors/management-api-error";
import fixture from "../fixtures/auth0-management-errors.json";

describe("management API errors", () => {
  it("builds Auth0's exact not-found body", async () => {
    const error = notFound.user();
    expect(error.status).toBe(404);
    expect(await error.getResponse().json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "The user does not exist.",
      errorCode: "inexistent_user",
    });
  });

  describe("formatValidationMessage", () => {
    const schema = z.object({
      name: z.string(),
      blocked: z.boolean().optional(),
      per_page: z.number().max(100).optional(),
      engine: z.enum(["v2", "v3"]).optional(),
      ids: z.array(z.string()).min(1).max(2).optional(),
    });

    const format = (target: string, data: unknown) => {
      const result = schema.strict().safeParse(data);
      if (result.success) throw new Error("expected a validation failure");
      return formatValidationMessage(target, result.error.issues, data);
    };

    it("reports a missing property like Auth0", () => {
      expect(format("json", {})).toEqual({
        statusCode: 400,
        error: "Bad Request",
        message: "Payload validation error: 'Missing required property: name'.",
        errorCode: "invalid_body",
      });
    });

    it("reports a wrong type with the property name", () => {
      expect(format("json", { name: "x", blocked: "yes" }).message).toBe(
        "Payload validation error: 'Expected type boolean but found type string' on property blocked.",
      );
    });

    it("reports unknown properties", () => {
      expect(format("json", { name: "x", foo: 1 }).message).toBe(
        "Payload validation error: 'Additional properties not allowed: foo'.",
      );
    });

    it("uses the query prefix and code for query-string failures", () => {
      expect(format("query", { name: "x", per_page: 1000 })).toEqual({
        statusCode: 400,
        error: "Bad Request",
        message:
          "Query validation error: 'Value 1000 is greater than maximum 100' on property per_page.",
        errorCode: "invalid_query_string",
      });
    });

    it("quotes the rejected enum value", () => {
      expect(format("query", { name: "x", engine: "v9" }).message).toBe(
        `Query validation error: 'Invalid value "v9"' on property engine.`,
      );
    });

    it("preserves an empty array in minimum-length errors", () => {
      expect(format("json", { name: "x", ids: [] })).toEqual({
        statusCode: 400,
        error: "Bad Request",
        message:
          "Payload validation error: 'Value [] is less than minimum 1' on property ids.",
        errorCode: "invalid_body",
      });
    });

    it("preserves array elements in maximum-length errors", () => {
      expect(
        format("json", { name: "x", ids: ["a,b", 'c"d', ""] }).message,
      ).toBe(
        `Payload validation error: 'Value ["a,b","c\\"d",""] is greater than maximum 2' on property ids.`,
      );
    });

    it("joins several failures with (also)", () => {
      expect(format("json", { blocked: "yes" }).message).toBe(
        "Payload validation error: 'Missing required property: name'. (also) Payload validation error: 'Expected type boolean but found type string' on property blocked.",
      );
    });

    it("uses the path prefix and invalid_uri for path params", () => {
      expect(format("param", {}).errorCode).toBe("invalid_uri");
    });
  });

  it("managementValidationHook picks the code from the failing request part", async () => {
    const app = new OpenAPIHono({ defaultHook: managementValidationHook });
    app.openapi(
      createRoute({
        method: "post",
        path: "/items",
        request: {
          query: z.object({ per_page: z.coerce.number().max(100).optional() }),
          body: {
            content: {
              "application/json": { schema: z.object({ name: z.string() }) },
            },
          },
        },
        responses: { 200: { description: "ok" } },
      }),
      (ctx) => ctx.json({}, 200),
    );

    const badQuery = await app.request("/items?per_page=1000", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(badQuery.status).toBe(400);
    expect(await badQuery.json()).toMatchObject({
      errorCode: "invalid_query_string",
    });

    const badBody = await app.request("/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(await badBody.json()).toEqual({
      statusCode: 400,
      error: "Bad Request",
      message: "Payload validation error: 'Missing required property: name'.",
      errorCode: "invalid_body",
    });
  });
});

// Contract test against bodies captured from a live Auth0 tenant. Where Auth0
// sends an errorCode ours must be identical; where it sends none we add one
// (documented under "AuthHero extensions" in apps/docs/api/error-codes.md).
describe("Auth0 contract", () => {
  const captured: Array<{ case: string; status: number; body: object }> =
    fixture.responses;
  const auth0Body = (name: string) => {
    const row = captured.find((r) => r.case === name);
    if (!row) throw new Error(`fixture case missing: ${name}`);
    return row.body;
  };

  const cases: Array<[string, HTTPException]> = [
    ["user", notFound.user()],
    ["add users to role (valid format)", notFound.users()],
    ["client", notFound.client()],
    ["patch client", notFound.clientOnUpdate()],
    ["connection", notFound.connection()],
    ["resource server", notFound.resourceServer()],
    [
      "create client grant fake client",
      notFound.resourceServerByIdentifier("https://doesnotexist.example/"),
    ],
    ["client grant", notFound.clientGrant()],
    ["log", notFound.log()],
    ["job", notFound.job()],
    ["custom domain", notFound.customDomain("cd_doesnotexist0000")],
    ["signing key", notFound.key("doesnotexist")],
    ["hook", notFound.hook()],
    ["guardian enrollment", notFound.enrollment()],
    ["role (valid format)", notFound.role()],
    ["patch role (valid format)", notFound.roleOnUpdate()],
    ["organization", notFound.organization()],
    ["action", notFound.action()],
    ["conflict: user email+username", conflict.userExists()],
    [
      "conflict: resource server identifier",
      conflict.resourceServer("https://api.example.com"),
    ],
    ["conflict: org name", conflict.organizationName()],
    [
      "missing scope (sessions)",
      authErrors.insufficientScope(["read:sessions"]),
    ],
  ];

  it.each(cases)("%s matches Auth0", async (name, error) => {
    const ours: unknown = await error.getResponse().json();
    const theirs = auth0Body(name);
    expect(error.status).toBe(captured.find((r) => r.case === name)?.status);
    if ("errorCode" in theirs) {
      expect(ours).toEqual(theirs);
    } else {
      expect(ours).toMatchObject(theirs);
      expect(ours).toHaveProperty("errorCode");
    }
  });
});

describe("formatValidationMessage without source data", () => {
  it("doesn't report a wrong-typed field as missing", () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 5 });
    if (result.success) throw new Error("expected a validation failure");
    const { message } = formatValidationMessage(
      "json",
      result.error.issues,
      undefined,
    );
    expect(message).not.toContain("Missing required property");
    expect(message).toContain("on property name");
  });
});
