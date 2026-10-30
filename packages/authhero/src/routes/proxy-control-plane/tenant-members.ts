import { Hono, type Context } from "hono";
import { Bindings } from "../../types";
import {
  TenantInvitationNotFoundError,
  TenantMembersBackend,
  TenantMembersNotFoundError,
} from "../../tenant-members/types";
import {
  TENANT_MEMBERS_NOT_FOUND_HEADER,
  TenantMembersNotFoundKind,
  createInvitationBodySchema,
  memberRolesBodySchema,
  membersMutationBodySchema,
  notifyMemberRequestBodySchema,
} from "../../tenant-members/wire";
import type { AuthenticateControlPlane } from "./custom-domains";
import { CONTROL_PLANE_TENANT_MEMBERS_SCOPE } from "./scopes";
import { authenticateControlPlaneRequest } from "./verify";

type TenantVars = { tenantId: string };

/** Context seen by the control-plane resource: env + the pinned tenant id. */
type CpCtx = Context<{ Bindings: Bindings; Variables: TenantVars }>;

export interface TenantMembersControlPlaneOptions {
  /**
   * Build the backend for a request. Bound to the control-plane database
   * (`c.env.data`) and, optionally, an email sender at wire-up time. The tenant
   * is pinned separately from the verified token, so the factory does not need
   * it. Pass `c` as the local backend's `ctx` to send invitation emails as the
   * control-plane tenant.
   */
  getBackend: (
    c: CpCtx,
  ) => TenantMembersBackend | Promise<TenantMembersBackend>;
  /**
   * Team-change requests (issue #1550). A shard registers a request in its own
   * database and calls `POST /requests/notify` with its id; `onNotify` takes
   * it from there, typically by enqueueing a tenant operation that reads the
   * request from the shard and carries it out. `tenantId` is the verified
   * token's, never the body's. Unset, the endpoint answers 501 and the shard
   * keeps the request until a control plane that has it is in place.
   */
  requests?: {
    onNotify: (c: CpCtx, tenantId: string, requestId: string) => Promise<void>;
  };
  /**
   * Defaults to verifying a `controlplane:tenant_members` bearer token issued
   * by `env.ISSUER` or the inbound host. Ignored under
   * `createProxyControlPlaneApp`, which always applies that check together with
   * its own `jwksFetch` / `isTrustedIssuer`.
   */
  authenticate?: AuthenticateControlPlane;
}

/**
 * The authoritative `tenant-members` resource. Tenant shards reach it through
 * `createControlPlaneTenantMembersAdapter`; it manages the control-plane
 * organization that models a tenant's team — rows the shard cannot write.
 *
 * Every operation is bound to the `tenant_id` claim of the verified token. The
 * scope alone is not authorization: each shard holds it, so a request-supplied
 * tenant id would let any shard read or edit any other tenant's team. Mount
 * under `/api/v2/proxy/control-plane/tenant-members`.
 */
export function createTenantMembersControlPlaneApp(
  options: TenantMembersControlPlaneOptions,
): Hono<{ Bindings: Bindings; Variables: TenantVars }> {
  const app = new Hono<{ Bindings: Bindings; Variables: TenantVars }>();
  const { getBackend } = options;
  const authenticate: AuthenticateControlPlane =
    options.authenticate ??
    ((c) =>
      authenticateControlPlaneRequest(c, CONTROL_PLANE_TENANT_MEMBERS_SCOPE));

  app.use("*", async (c, next) => {
    const result = await authenticate(c);
    if (!result.ok) {
      console.warn(
        `[proxy/control-plane/tenant-members] authentication failed: ${result.reason}`,
      );
      return c.text("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
    }
    // Fail closed: a token with no tenant binding cannot act on any team.
    if (!result.tenantId) {
      console.warn(
        "[proxy/control-plane/tenant-members] token carries no tenant_id claim",
      );
      return c.text("Forbidden", 403);
    }
    c.set("tenantId", result.tenantId);
    return next();
  });

  /**
   * Refuse a request that names a tenant other than the one it authenticated
   * as, instead of silently acting on the authenticated tenant.
   */
  function claimedMismatch(tenantId: string, claimed: string | undefined) {
    return claimed !== undefined && claimed !== tenantId;
  }

  async function readJson(c: CpCtx): Promise<unknown | undefined> {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  }

  // Map the backend's "not there" signal to 404, naming what is missing in
  // TENANT_MEMBERS_NOT_FOUND_HEADER; everything else propagates to the app's
  // onError.
  async function run<T>(c: CpCtx, op: () => Promise<T>): Promise<Response | T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof TenantMembersNotFoundError) {
        const kind: TenantMembersNotFoundKind =
          err instanceof TenantInvitationNotFoundError
            ? "invitation"
            : "organization";
        return c.text("Not found", 404, {
          [TENANT_MEMBERS_NOT_FOUND_HEADER]: kind,
        });
      }
      throw err;
    }
  }

  app.get("/members", async (c) => {
    const tenantId = c.get("tenantId");
    if (claimedMismatch(tenantId, c.req.query("tenant_id"))) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const page = c.req.query("page");
    const perPage = c.req.query("per_page");
    const result = await run(c, () =>
      backend.listMembers(tenantId, {
        page: page ? Number(page) : undefined,
        per_page: perPage ? Number(perPage) : undefined,
        q: c.req.query("q") || undefined,
      }),
    );
    return result instanceof Response ? result : c.json(result);
  });

  app.post("/members", async (c) => {
    const tenantId = c.get("tenantId");
    const parsed = membersMutationBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.issues },
        400,
      );
    }
    if (claimedMismatch(tenantId, parsed.data.tenant_id)) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const r = await run(c, () =>
      backend.addMembers(tenantId, parsed.data.user_ids),
    );
    return r instanceof Response ? r : c.body(null, 204);
  });

  app.delete("/members", async (c) => {
    const tenantId = c.get("tenantId");
    const parsed = membersMutationBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.issues },
        400,
      );
    }
    if (claimedMismatch(tenantId, parsed.data.tenant_id)) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const r = await run(c, () =>
      backend.removeMembers(tenantId, parsed.data.user_ids),
    );
    return r instanceof Response ? r : c.body(null, 204);
  });

  app.get("/members/:user_id/roles", async (c) => {
    const tenantId = c.get("tenantId");
    if (claimedMismatch(tenantId, c.req.query("tenant_id"))) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const r = await run(c, () =>
      backend.listMemberRoles(tenantId, c.req.param("user_id")),
    );
    return r instanceof Response ? r : c.json(r);
  });

  app.post("/members/:user_id/roles", async (c) => {
    const tenantId = c.get("tenantId");
    const parsed = memberRolesBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.issues },
        400,
      );
    }
    if (claimedMismatch(tenantId, parsed.data.tenant_id)) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const r = await run(c, () =>
      backend.assignMemberRoles(
        tenantId,
        c.req.param("user_id"),
        parsed.data.roles,
      ),
    );
    return r instanceof Response ? r : c.body(null, 204);
  });

  app.delete("/members/:user_id/roles", async (c) => {
    const tenantId = c.get("tenantId");
    const parsed = memberRolesBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.issues },
        400,
      );
    }
    if (claimedMismatch(tenantId, parsed.data.tenant_id)) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const r = await run(c, () =>
      backend.removeMemberRoles(
        tenantId,
        c.req.param("user_id"),
        parsed.data.roles,
      ),
    );
    return r instanceof Response ? r : c.body(null, 204);
  });

  app.get("/roles", async (c) => {
    const tenantId = c.get("tenantId");
    if (claimedMismatch(tenantId, c.req.query("tenant_id"))) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const page = c.req.query("page");
    const perPage = c.req.query("per_page");
    const r = await run(c, () =>
      backend.listRoles(tenantId, {
        page: page ? Number(page) : undefined,
        per_page: perPage ? Number(perPage) : undefined,
        q: c.req.query("q") || undefined,
      }),
    );
    return r instanceof Response ? r : c.json(r);
  });

  app.get("/invitations", async (c) => {
    const tenantId = c.get("tenantId");
    if (claimedMismatch(tenantId, c.req.query("tenant_id"))) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const page = c.req.query("page");
    const perPage = c.req.query("per_page");
    const r = await run(c, () =>
      backend.listInvitations(tenantId, {
        page: page ? Number(page) : undefined,
        per_page: perPage ? Number(perPage) : undefined,
      }),
    );
    return r instanceof Response ? r : c.json(r);
  });

  app.post("/invitations", async (c) => {
    const tenantId = c.get("tenantId");
    const parsed = createInvitationBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.issues },
        400,
      );
    }
    const { tenant_id: claimed, ...input } = parsed.data;
    if (claimedMismatch(tenantId, claimed)) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const r = await run(c, () => backend.createInvitation(tenantId, input));
    return r instanceof Response ? r : c.json(r, 201);
  });

  app.post("/requests/notify", async (c) => {
    const tenantId = c.get("tenantId");
    if (!options.requests) {
      return c.json({ error: "not_implemented" }, 501);
    }
    const parsed = notifyMemberRequestBodySchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", details: parsed.error.issues },
        400,
      );
    }
    if (claimedMismatch(tenantId, parsed.data.tenant_id)) {
      return c.text("Forbidden", 403);
    }
    await options.requests.onNotify(c, tenantId, parsed.data.request_id);
    return c.json({ request_id: parsed.data.request_id }, 202);
  });

  app.delete("/invitations/:id", async (c) => {
    const tenantId = c.get("tenantId");
    if (claimedMismatch(tenantId, c.req.query("tenant_id"))) {
      return c.text("Forbidden", 403);
    }
    const backend = await getBackend(c);
    const r = await run(c, () =>
      backend.revokeInvitation(tenantId, c.req.param("id")),
    );
    return r instanceof Response ? r : c.body(null, 204);
  });

  return app;
}
