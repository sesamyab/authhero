import { Context } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { JSONHTTPException } from "./json-http-exception";

/**
 * Management API errors in Auth0's wire shape. Auth0 SDKs (go-auth0, the
 * Terraform provider, node-auth0) parse `{ statusCode, error, message,
 * errorCode }` and branch on `errorCode`.
 *
 * The bodies below are a superset of Auth0's: where Auth0 returns a message or
 * errorCode we return the same bytes (captured from a live tenant, see
 * apps/docs/api/error-codes.md), and where Auth0 omits `errorCode` we add one.
 * Every added code is listed under "AuthHero extensions" in that doc page —
 * keep the two in sync.
 */

export const ERROR_TEXT_BY_STATUS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
};

export interface ManagementErrorBody {
  statusCode: number;
  error: string;
  message: string;
  errorCode?: string;
}

export function managementErrorBody(
  status: number,
  message: string,
  errorCode?: string,
): ManagementErrorBody {
  return {
    statusCode: status,
    error: ERROR_TEXT_BY_STATUS[status] ?? "Error",
    message,
    ...(errorCode ? { errorCode } : {}),
  };
}

export function managementError(
  status: ContentfulStatusCode,
  message: string,
  errorCode?: string,
): JSONHTTPException {
  return new JSONHTTPException(
    status,
    managementErrorBody(status, message, errorCode),
  );
}

const notFoundError = (message: string, errorCode: string) => () =>
  managementError(404, message, errorCode);

/**
 * 404s per resource. Messages marked "auth0" are byte-identical to Auth0
 * (including its inconsistent trailing periods); the rest are AuthHero
 * resources or Auth0 resources without an errorCode, and follow the
 * `The <resource> does not exist.` / `inexistent_<resource>` convention.
 */
export const notFound = {
  // auth0
  user: notFoundError("The user does not exist.", "inexistent_user"),
  users: notFoundError(
    "One or more of the users do not exist.",
    "inexistent_user",
  ),
  client: notFoundError("The client does not exist", "inexistent_client"),
  clientOnUpdate: notFoundError(
    "The client does not exist.",
    "inexistent_client",
  ),
  connection: notFoundError(
    "The connection does not exist",
    "inexistent_connection",
  ),
  resourceServer: notFoundError(
    "The resource server does not exist",
    "inexistent_resource_server",
  ),
  resourceServerByIdentifier: (identifier: string) =>
    managementError(
      404,
      `No resource with identifier ${identifier}`,
      "inexistent_resource_server",
    ),
  clientGrant: notFoundError(
    "The grant does not exist.",
    "inexistent_client_grant",
  ),
  log: notFoundError("The log does not exist.", "inexistent_log"),
  job: notFoundError("The job does not exist", "inexistent_job"),
  customDomain: (id: string) =>
    managementError(
      404,
      `The custom domain ${id} does not exist`,
      "inexistent_custom_domain",
    ),
  key: (kid: string) =>
    managementError(
      404,
      `The key with key ID "${kid}" was not found.`,
      "inexistent_tenant_key",
    ),
  hook: notFoundError("Error: Hook does not exist", "HookDoesNotExist"),
  enrollment: notFoundError("Enrollment not found", "enrollment_not_found"),
  // auth0 message, errorCode added (Auth0 sends none)
  role: notFoundError("The role does not exist.", "inexistent_role"),
  roleOnUpdate: notFoundError("No such role.", "inexistent_role"),
  organization: notFoundError(
    "No organization found by that id or name",
    "inexistent_organization",
  ),
  action: notFoundError("That action does not exist.", "inexistent_action"),
  // authhero resources / resources not captured from Auth0
  tenant: notFoundError("The tenant does not exist.", "inexistent_tenant"),
  invitation: notFoundError(
    "The invitation does not exist.",
    "inexistent_invitation",
  ),
  member: notFoundError("The member does not exist.", "inexistent_member"),
  identity: notFoundError(
    "The identity does not exist.",
    "inexistent_identity",
  ),
  session: notFoundError("The session does not exist.", "inexistent_session"),
  refreshToken: notFoundError(
    "The refresh token does not exist.",
    "inexistent_refresh_token",
  ),
  grant: notFoundError("The grant does not exist.", "inexistent_grant"),
  logStream: notFoundError(
    "The log stream does not exist.",
    "inexistent_log_stream",
  ),
  form: notFoundError("The form does not exist.", "inexistent_form"),
  flow: notFoundError("The flow does not exist.", "inexistent_flow"),
  emailTemplate: notFoundError(
    "The email template does not exist.",
    "inexistent_email_template",
  ),
  emailProvider: notFoundError(
    "The email provider does not exist.",
    "inexistent_email_provider",
  ),
  authenticationMethod: notFoundError(
    "The authentication method does not exist.",
    "inexistent_authentication_method",
  ),
  actionExecution: notFoundError(
    "The action execution does not exist.",
    "inexistent_action_execution",
  ),
  actionVersion: notFoundError(
    "The action version does not exist.",
    "inexistent_action_version",
  ),
  hookCode: notFoundError(
    "The hook code does not exist.",
    "inexistent_hook_code",
  ),
  failedEvent: notFoundError(
    "The failed event does not exist.",
    "inexistent_failed_event",
  ),
  migrationSource: notFoundError(
    "The migration source does not exist.",
    "inexistent_migration_source",
  ),
  proxyRoute: notFoundError(
    "The proxy route does not exist.",
    "inexistent_proxy_route",
  ),
  scimConfiguration: notFoundError(
    "The SCIM configuration does not exist.",
    "inexistent_scim_configuration",
  ),
  scimToken: notFoundError(
    "The SCIM token does not exist.",
    "inexistent_scim_token",
  ),
  tenantOperation: notFoundError(
    "The tenant operation does not exist.",
    "inexistent_tenant_operation",
  ),
  tokenExchangeProfile: notFoundError(
    "The token exchange profile does not exist.",
    "inexistent_token_exchange_profile",
  ),
};

/**
 * 409s. `userExists`, `resourceServer` and `organizationName` are Auth0's
 * bodies (the "identifer" typo is Auth0's, kept byte-identical); the
 * organization errorCode is added.
 */
export const conflict = {
  userExists: () =>
    managementError(409, "The user already exists.", "auth0_idp_error"),
  resourceServer: (identifier: string) =>
    managementError(
      409,
      `A resource server already exists with identifer ${identifier}`,
      "resource_server_conflict",
    ),
  organizationName: () =>
    managementError(
      409,
      "An organization with this name already exists.",
      "organization_conflict",
    ),
  /** Any other AuthHero conflict: own message, shared code. */
  other: (message: string) => managementError(409, message, "conflict"),
};

export const authErrors = {
  missingAuthentication: () =>
    managementError(401, "Missing authentication", "missing_authentication"),
  invalidToken: (message = "Invalid token") =>
    managementError(401, message, "invalid_token"),
  insufficientScope: (expected: string[]) =>
    managementError(
      403,
      `Insufficient scope, expected any of: ${expected.join(",")}`,
      "insufficient_scope",
    ),
};

// ---------------------------------------------------------------------------
// Request validation (zod) → Auth0's validation messages
// ---------------------------------------------------------------------------

const VALIDATION_PREFIX: Record<string, { prefix: string; code: string }> = {
  json: { prefix: "Payload validation error", code: "invalid_body" },
  form: { prefix: "Payload validation error", code: "invalid_body" },
  query: { prefix: "Query validation error", code: "invalid_query_string" },
  param: { prefix: "Path validation error", code: "invalid_uri" },
  header: { prefix: "Header validation error", code: "invalid_headers" },
};

interface ValidationIssue {
  code?: string;
  path?: PropertyKey[];
  message?: string;
  expected?: string;
  keys?: string[];
  maximum?: number | bigint;
  minimum?: number | bigint;
  origin?: string;
  format?: string;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function valueAt(data: unknown, path: PropertyKey[]): unknown {
  let current = data;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describeIssue(issue: ValidationIssue, data: unknown) {
  const path = (issue.path ?? []).map(String);
  const input = valueAt(data, issue.path ?? []);

  switch (issue.code) {
    case "invalid_type":
      // Without the source data (the index.ts fallback), a missing field and
      // a wrong-typed one look the same, so defer to zod's own message.
      if (data === undefined) {
        return { detail: issue.message ?? "Invalid value", path };
      }
      if (input === undefined) {
        return {
          detail: `Missing required property: ${path[path.length - 1] ?? "root"}`,
          path: path.slice(0, -1),
        };
      }
      return {
        detail: `Expected type ${issue.expected} but found type ${typeName(input)}`,
        path,
      };
    case "unrecognized_keys":
      return {
        detail: `Additional properties not allowed: ${(issue.keys ?? []).join(",")}`,
        path,
      };
    case "invalid_value":
    case "invalid_enum_value":
      return { detail: `Invalid value ${JSON.stringify(input)}`, path };
    case "too_big":
      return {
        detail:
          issue.origin === "string"
            ? `String is too long (${String(input).length} chars), maximum ${issue.maximum}`
            : `Value ${String(input)} is greater than maximum ${issue.maximum}`,
        path,
      };
    case "too_small":
      return {
        detail:
          issue.origin === "string"
            ? `String is too short (${String(input).length} chars), minimum ${issue.minimum}`
            : `Value ${String(input)} is less than minimum ${issue.minimum}`,
        path,
      };
    case "invalid_format":
      return {
        detail: `Object didn't pass validation for format ${issue.format}: ${String(input)}`,
        path,
      };
    default:
      return { detail: issue.message ?? "Invalid value", path };
  }
}

/**
 * Formats zod issues the way Auth0 does:
 * `Payload validation error: 'Missing required property: name'.`, joined with
 * ` (also) ` when there are several. Auth0 also appends each property's
 * schema description, which we don't have at this layer.
 */
export function formatValidationMessage(
  target: string,
  issues: unknown[],
  data: unknown,
): ManagementErrorBody {
  const { prefix, code } = VALIDATION_PREFIX[target] ?? {
    prefix: "Payload validation error",
    code: "invalid_body",
  };
  const parts = issues.filter(isValidationIssue).map((issue) => {
    const { detail, path } = describeIssue(issue, data);
    const on = path.length ? ` on property ${path.join(".")}` : "";
    return `${prefix}: '${detail}'${on}.`;
  });
  return managementErrorBody(400, parts.join(" (also) ") || prefix, code);
}

// Every field of ValidationIssue is optional and read defensively in
// describeIssue, so any object qualifies.
function isValidationIssue(value: unknown): value is ValidationIssue {
  return isRecord(value);
}

function issuesOf(error: unknown): unknown[] {
  return isRecord(error) && Array.isArray(error.issues) ? error.issues : [];
}

/**
 * `defaultHook` for every management-api OpenAPIHono app. The hook is the only
 * place zod-openapi exposes which part of the request failed, which is what
 * picks Auth0's invalid_body / invalid_query_string / invalid_uri code.
 */
export function managementValidationHook(
  result: { success: boolean; target: string; data?: unknown; error?: unknown },
  ctx: Context,
) {
  if (result.success) return;
  return ctx.json(
    formatValidationMessage(result.target, issuesOf(result.error), result.data),
    400,
  );
}
