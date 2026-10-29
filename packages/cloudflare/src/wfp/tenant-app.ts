import { Hono, type Context, type ExecutionContext } from "hono";
import {
  init,
  loadEncryptionKey,
  createEncryptedDataAdapterWithKeyRing,
  ensureSigningKey,
  renewSigningCertificates,
  SigningCertificateRenewalError,
  TENANT_URI_PREFIX,
  type AuthHeroConfig,
  type CertificateIssuer,
  type SigningCertificateAuthority,
  type DataAdapters,
  type IssuerResolver,
} from "authhero";
import {
  withRuntimeFallback,
  applyControlPlaneDefaultsPayload,
  applyResolvedConfigBlock,
  createShadowReporter,
  detachTenantRows,
  markTenantDetached,
  type ControlPlaneDefaultsApplyResult,
  type InheritanceShadowOptions,
  type ResolvedConfigBlock,
  type ControlPlaneDefaultsPayload,
} from "@authhero/multi-tenancy";

const CONTROL_PLANE_KEY_ID = "cp";
const SYNC_PATH = "/internal/sync-defaults";
const SYNC_CONFIG_PATH = "/internal/sync-config";
const DETACH_PATH = "/internal/detach";
const TENANT_MEMBER_REQUESTS_PATH = "/internal/tenant-member-requests";
const RENEW_CERTIFICATES_PATH = "/internal/renew-signing-certificates";

/**
 * Log the cause and return a structured 500: a stable error `code`, the
 * cause's message as `detail`, an `X-Authhero-Error: <code>` header, and the
 * apply `result` when one exists. Tenant workers run in a dispatch namespace
 * (no `wrangler tail`), so the opaque `{"message":"Internal Server Error"}`
 * the default handler emits is a debugging dead end — this is the only place
 * the cause surfaces.
 */
function errorResponse(
  c: Context,
  code: string,
  cause: unknown,
  result?: ControlPlaneDefaultsApplyResult,
): Response {
  console.error(`[wfp-tenant] ${code}:`, cause);
  const detail = cause instanceof Error ? cause.message : String(cause);
  c.header("X-Authhero-Error", code);
  return c.json({ error: code, detail, result }, 500);
}

/**
 * Env contract for a WFP tenant worker — the bindings + secrets
 * `createCloudflareWfpD1Provisioner` (and the host's `secrets` resolver) set on
 * each tenant script. `AUTH_DB` is the D1 binding; the rest are plain
 * text / secret text.
 */
export interface WfpTenantEnv {
  /** Per-tenant D1 binding. Consumed by the host's `createDataAdapter`. */
  AUTH_DB: unknown;
  /** This tenant's own at-rest encryption key (base64, 32 bytes). */
  ENCRYPTION_KEY: string;
  /** This tenant's JWT `iss`. */
  ISSUER: string;
  /** Control-plane tenant id whose projected defaults this worker inherits. */
  CONTROL_PLANE_TENANT_ID: string;
  /**
   * The control plane's own issuer. Accepted in addition to `ISSUER` so a
   * control-plane-minted admin token forwarded here verifies — its signature is
   * checked against the control plane's PUBLIC keys, which are projected into
   * this tenant's DB (no runtime JWKS fetch).
   */
  CONTROL_PLANE_ISSUER: string;
  /**
   * Key for the `cp` key-ring id — encrypts inherited control-plane rows so the
   * tenant operator can hold but not read them. When omitted, a single key is
   * used for everything.
   */
  CONTROL_PLANE_ENCRYPTION_KEY?: string;
  /** Shared secret authenticating control-plane pushes to `/internal/sync-defaults`. */
  WFP_INTERNAL_SYNC_SECRET?: string;
  /**
   * The tenant this worker serves, set when the script is provisioned (plain
   * text binding or secret, next to `ISSUER`). When present,
   * `/internal/sync-config` refuses a push addressed to any other tenant, so a
   * misrouted push can never write another tenant's config into this database.
   * Optional so workers provisioned before it existed keep working; set it from
   * the provisioner's `secrets` resolver.
   */
  TENANT_ID?: string;
  [key: string]: unknown;
}

export interface WfpTenantAppOptions<Env extends WfpTenantEnv = WfpTenantEnv> {
  /**
   * Builds the tenant's **base** data adapters from its env (typically
   * `createAdapters(drizzle(env.AUTH_DB))`). Injected so this package carries no
   * ORM dependency — the host owns the `@authhero/drizzle` (or other) import.
   */
  createDataAdapter: (env: Env) => DataAdapters;
  /**
   * Hook to extend or override the authhero config before `init` — add custom
   * hooks, code executors, `signingKeyMode`, extra issuers, etc. Receives the
   * scaffold's base config and the env. The `signingCertificateAuthority` it
   * returns is the one sync-defaults and the renew route use as well.
   */
  configure?: (base: AuthHeroConfig, env: Env) => AuthHeroConfig;
  /**
   * Resolver for the issuers accepted *in addition to* this tenant's own
   * `ISSUER`. Defaults to a **gated** resolver that accepts
   * `env.CONTROL_PLANE_ISSUER` **only** for control-plane-minted tokens
   * (`tenant_id === env.CONTROL_PLANE_TENANT_ID`) and `[]` otherwise — so a
   * tenant token can never assert the control-plane issuer. Provide your own
   * resolver to widen or narrow this; it fully replaces the default.
   */
  additionalIssuers?: (env: Env) => IssuerResolver;
  /**
   * When applying a `/internal/sync-defaults` push, keep going past a failing
   * row and collect per-entity errors in the result rather than aborting the
   * whole projection on the first failure. Defaults to `true` — a single bad
   * inherited row shouldn't sink the entire sync into an opaque 500. Set
   * `false` to restore fail-fast.
   */
  continueOnError?: boolean;
  /**
   * Called after a `/internal/sync-defaults` push is applied, with the result
   * that is also returned to the control plane. Use it to log what landed
   * (per-entity `received` / `upserted` / `errors`) without re-implementing the
   * route. A throw here is caught and turns into a structured 500 — the apply
   * has already committed, so treat it as best-effort logging.
   */
  onSyncResult?: (
    result: ControlPlaneDefaultsApplyResult,
    env: Env,
  ) => void | Promise<void>;
  /**
   * Issue this tenant's signing certificates from a CA, so a resource server
   * can trust them through one pinned root. Typically an HTTP issuer, so the
   * CA key stays out of the tenant worker.
   *
   * `tenantId` is required because a tenant worker stores its own keys
   * without a `tenant_id`: without it the certificate would claim the
   * control-plane URN, which resource servers trust for every tenant.
   * Renew with `POST /internal/renew-signing-certificates`, pushed by the
   * control plane via `createDispatchRenewSigningCertificates`.
   */
  signingCertificateAuthority?: (
    env: Env,
  ) => WfpSigningCertificateAuthority | undefined;
  /**
   * Shadow mode for config inheritance, run in this worker: after a request is
   * answered, compare what the projected control-plane rows give this tenant
   * (the runtime fallback) with what its parent chain resolves to, and log the
   * differences as `cfgdiff` in this tenant's own logs
   * (`GET /api/v2/logs?q=type:cfgdiff`, forwarded here). Never changes a
   * response. The comparison runs under `ctx.waitUntil`, so the Worker keeps
   * it alive after the response; it is sampled and rate-limited like the
   * colocated shadow mode. `true` uses the defaults.
   *
   * The worker only knows the control plane's rows (the ones projected into its
   * database) and the tenant's own, so it compares against those. If the
   * tenant's row names a parent this database lacks, the comparison is skipped;
   * a deeper chain is checked by _Verify_ on the control plane.
   */
  inheritanceShadow?: boolean | InheritanceShadowOptions;
}

export interface WfpSigningCertificateAuthority {
  issuer: CertificateIssuer;
  /** The tenant this worker serves; certificates name `urn:authhero:tenant:<tenantId>`. */
  tenantId: string;
  /** Certificate lifetime in days. Defaults to the authhero default (30). */
  validityDays?: number;
}

/**
 * Pin the SAN to this worker's tenant. The authhero default derives it from
 * the key's `tenant_id`, which a tenant worker's own keys don't have.
 */
function tenantCertificateAuthority(
  ca: WfpSigningCertificateAuthority,
): SigningCertificateAuthority {
  const uri = `${TENANT_URI_PREFIX}${ca.tenantId}`;
  return {
    issuer: ca.issuer,
    validityDays: ca.validityDays,
    subjectUri: () => uri,
  };
}

/** Default additional-issuers resolver: gate the control-plane issuer to control-plane tokens. */
function gatedControlPlaneIssuer<Env extends WfpTenantEnv>(
  env: Env,
): IssuerResolver {
  return ({ tenant_id }) =>
    tenant_id === env.CONTROL_PLANE_TENANT_ID ? [env.CONTROL_PLANE_ISSUER] : [];
}

async function buildTenantApp<Env extends WfpTenantEnv>(
  env: Env,
  options: WfpTenantAppOptions<Env>,
): Promise<Hono> {
  const controlPlaneTenantId = env.CONTROL_PLANE_TENANT_ID;

  // Encrypt this tenant's own rows under its key; inherited control-plane rows
  // under the "cp" key id (so a leaked D1 export can't reveal shared secrets).
  const tenantKey = await loadEncryptionKey(env.ENCRYPTION_KEY);
  const ring = env.CONTROL_PLANE_ENCRYPTION_KEY
    ? {
        default: tenantKey,
        keys: {
          [CONTROL_PLANE_KEY_ID]: await loadEncryptionKey(
            env.CONTROL_PLANE_ENCRYPTION_KEY,
          ),
        },
      }
    : { default: tenantKey };

  const rawAdapter = options.createDataAdapter(env);
  const encrypted = createEncryptedDataAdapterWithKeyRing(rawAdapter, ring, {
    resolveEncryptKeyId: (tenantId) =>
      tenantId === controlPlaneTenantId ? CONTROL_PLANE_KEY_ID : undefined,
  });

  // Runtime fallback resolves the projected control-plane rows from this same
  // D1 — identical to a colocated tenant, no WFP-specific read code.
  const dataAdapter = withRuntimeFallback(encrypted, {
    controlPlaneTenantId,
  });

  const wfpCertificateAuthority = options.signingCertificateAuthority?.(env);
  const certificateAuthority = wfpCertificateAuthority
    ? tenantCertificateAuthority(wfpCertificateAuthority)
    : undefined;

  const baseConfig: AuthHeroConfig = {
    dataAdapter,
    // Rotation, the renew endpoint and the JWKS x5c all read this.
    ...(certificateAuthority
      ? { signingCertificateAuthority: certificateAuthority }
      : {}),
    // Accept the control plane's issuer for forwarded admin tokens — but only
    // for control-plane tokens (see `gatedControlPlaneIssuer`). The signature
    // is still verified, against the projected control-plane keys.
    additionalIssuers: (options.additionalIssuers ?? gatedControlPlaneIssuer)(
      env,
    ),
  };
  const config = options.configure
    ? options.configure(baseConfig, env)
    : baseConfig;
  // The effective authority after `configure`: issuance at sync-defaults and
  // the renew route use the same CA as rotation and the JWKS x5c.
  const effectiveCertificateAuthority = config.signingCertificateAuthority;

  const { app: authheroApp } = init(config);

  const app = new Hono();

  // Receive control-plane default pushes (pure push — the only ingress for
  // defaults + verify keys). Registered before the authhero mount so it wins.
  app.post(SYNC_PATH, async (c) => {
    const secret = env.WFP_INTERNAL_SYNC_SECRET;
    const authorization = c.req.header("authorization");
    if (!secret || authorization !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let payload: ControlPlaneDefaultsPayload;
    try {
      payload = await c.req.json<ControlPlaneDefaultsPayload>();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    let result: ControlPlaneDefaultsApplyResult;
    try {
      // Apply to the key-ring adapter (pre-fallback) so projected secrets are
      // re-encrypted under "cp" and projected verify keys land with no
      // tenant_id. `continueOnError` keeps one bad inherited row from aborting
      // the whole projection into an opaque 500.
      result = await applyControlPlaneDefaultsPayload(
        payload,
        encrypted,
        controlPlaneTenantId,
        { continueOnError: options.continueOnError ?? true },
      );
    } catch (err) {
      // Dispatch-namespace workers can't be `wrangler tail`'d, so an opaque
      // 500 here is a dead end. Always log the cause and return a structured
      // body + `X-Authhero-Error` header so the control plane sees detail.
      return errorResponse(c, "sync_defaults_apply_failed", err);
    }

    // The projected defaults only carry the control plane's PUBLIC keys, so a
    // freshly provisioned tenant has nothing to sign tokens with and would 500
    // at /oauth/token (issue #1181). Mint the tenant's own private RS256 key
    // here — the first point where its data adapter exists. Written to the
    // key-ring adapter (control-plane scope, no tenant_id) so it resolves in
    // both signing-key modes; private material is generated locally and never
    // crosses the control-plane boundary. Idempotent: a re-sync is a no-op once
    // a signable key exists.
    let signingKey: { created: boolean };
    try {
      const ensured = await ensureSigningKey(encrypted.keys, {
        name: env.ISSUER,
        certificateAuthority: effectiveCertificateAuthority,
      });
      signingKey = { created: ensured.created };
    } catch (err) {
      return errorResponse(c, "sync_defaults_signing_key_failed", err, result);
    }

    if (options.onSyncResult) {
      try {
        await options.onSyncResult(result, env);
      } catch (err) {
        // The apply already committed; the host's logging hook failing
        // shouldn't masquerade as a successful sync, but the result is real.
        return errorResponse(c, "sync_defaults_on_result_failed", err, result);
      }
    }

    // Surface the signing-key outcome in the body so the control plane can
    // confirm provisioning wired a private key (dispatch workers aren't
    // tailable). Additive to the apply result the verify step reads from D1.
    return c.json({ ...result, signingKey });
  });

  // Receive a `sync-defaults` operation's resolved config block. Separate from
  // the provisioning seed above: it carries only the block and flags, applies
  // nothing else (no FK seeds, defaults or signing keys), and a dry run writes
  // nothing at all.
  app.post(SYNC_CONFIG_PATH, async (c) => {
    const secret = env.WFP_INTERNAL_SYNC_SECRET;
    const authorization = c.req.header("authorization");
    if (!secret || authorization !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: {
      tenantId?: string;
      resolved?: ResolvedConfigBlock;
      dryRun?: boolean;
      force?: boolean;
      prune?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body.tenantId || !body.resolved) {
      return c.json({ error: "tenantId and resolved are required" }, 400);
    }
    // Refuse before any read or write when the push is for another tenant.
    if (env.TENANT_ID && body.tenantId !== env.TENANT_ID) {
      console.error(
        `[wfp-tenant] sync_config_tenant_mismatch: push for "${body.tenantId}" reached the worker of "${env.TENANT_ID}"`,
      );
      c.header("X-Authhero-Error", "sync_config_tenant_mismatch");
      return c.json({ error: "sync_config_tenant_mismatch" }, 403);
    }

    try {
      // The raw layer, so ciphertext is copied as stored; the key ring check
      // refuses the push before any write when this tenant cannot decrypt a
      // key id the block carries.
      const result = await applyResolvedConfigBlock(
        body.resolved,
        rawAdapter,
        body.tenantId,
        {
          dryRun: body.dryRun === true,
          force: body.force === true,
          prune: body.prune === true,
          keyRing: ring,
          continueOnError: options.continueOnError ?? true,
        },
      );
      return c.json(result);
    } catch (err) {
      // A key ring that cannot decrypt is a configuration problem the control
      // plane must fix; retrying will not help.
      const unreadable =
        err instanceof Error && /key ring cannot decrypt/.test(err.message);
      if (unreadable) {
        console.error("[wfp-tenant] sync_config_key_ring:", err);
        c.header("X-Authhero-Error", "sync_config_key_ring");
        return c.json(
          { error: "sync_config_key_ring", detail: err.message },
          422,
        );
      }
      return errorResponse(c, "sync_config_apply_failed", err);
    }
  });

  // Receive a `detach` operation: turn (or with `clean`, remove) the copies a
  // sync delivered into this tenant's own database. Only the rows are handled
  // here. Whether the tenant may be detached is decided on the control plane,
  // which holds the tenant row; this worker's own row is only marked afterwards.
  app.post(DETACH_PATH, async (c) => {
    const secret = env.WFP_INTERNAL_SYNC_SECRET;
    const authorization = c.req.header("authorization");
    if (!secret || authorization !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: { tenantId?: string; dryRun?: boolean; clean?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body.tenantId) {
      return c.json({ error: "tenantId is required" }, 400);
    }
    if (env.TENANT_ID && body.tenantId !== env.TENANT_ID) {
      console.error(
        `[wfp-tenant] detach_tenant_mismatch: detach for "${body.tenantId}" reached the worker of "${env.TENANT_ID}"`,
      );
      c.header("X-Authhero-Error", "detach_tenant_mismatch");
      return c.json({ error: "detach_tenant_mismatch" }, 403);
    }

    try {
      // The raw layer, so secrets are copied as stored.
      const result = await detachTenantRows(rawAdapter, body.tenantId, {
        dryRun: body.dryRun === true,
        clean: body.clean === true,
      });
      if (result.status === "detached") {
        await markTenantDetached(rawAdapter, body.tenantId);
      }
      return c.json(result);
    } catch (err) {
      return errorResponse(c, "detach_failed", err);
    }
  });

  // The control plane's access to this tenant's team-change requests (issue
  // #1550): read one, answer it with the outcome, or list the pending ones.
  // The requests live only in this database, so the control plane asks for
  // them here instead of trusting what a notification says.
  app.post(TENANT_MEMBER_REQUESTS_PATH, async (c) => {
    const secret = env.WFP_INTERNAL_SYNC_SECRET;
    const authorization = c.req.header("authorization");
    if (!secret || authorization !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: {
      tenantId?: string;
      action?: string;
      id?: string;
      olderThan?: string;
      outcome?: {
        status?: string;
        result?: Record<string, unknown> | null;
        error?: string | null;
      };
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body.tenantId) {
      return c.json({ error: "tenantId is required" }, 400);
    }
    if (env.TENANT_ID && body.tenantId !== env.TENANT_ID) {
      console.error(
        `[wfp-tenant] member_requests_tenant_mismatch: a request for "${body.tenantId}" reached the worker of "${env.TENANT_ID}"`,
      );
      c.header("X-Authhero-Error", "member_requests_tenant_mismatch");
      return c.json({ error: "member_requests_tenant_mismatch" }, 403);
    }

    const requests = rawAdapter.tenantMemberRequests;
    if (!requests) {
      return c.json({ error: "tenant member requests are not available" }, 501);
    }

    try {
      switch (body.action) {
        case "get": {
          if (!body.id) return c.json({ error: "id is required" }, 400);
          const request = await requests.get(body.tenantId, body.id);
          return request
            ? c.json(request)
            : c.json({ error: "not_found" }, 404);
        }
        case "report": {
          const { status, result, error } = body.outcome ?? {};
          if (!body.id || (status !== "succeeded" && status !== "failed")) {
            return c.json({ error: "id and a final status are required" }, 400);
          }
          // Only a pending request is finished, so a repeat changes nothing.
          const updated = await requests.update(
            body.tenantId,
            body.id,
            {
              status,
              result: result ?? null,
              error: error ?? null,
              finished_at: new Date().toISOString(),
            },
            "pending",
          );
          return c.json({ updated });
        }
        case "list_pending": {
          const list = await requests.list(body.tenantId, {
            status: "pending",
            created_before: body.olderThan,
            per_page: 100,
          });
          return c.json({ requests: list.requests });
        }
        default:
          return c.json({ error: "unknown action" }, 400);
      }
    } catch (err) {
      return errorResponse(c, "member_requests_failed", err);
    }
  });

  // Renew this tenant's CA-issued certificates. Pushed by the control plane
  // (`createDispatchRenewSigningCertificates`) because tenant workers in a
  // dispatch namespace have no schedule of their own.
  app.post(RENEW_CERTIFICATES_PATH, async (c) => {
    const secret = env.WFP_INTERNAL_SYNC_SECRET;
    const authorization = c.req.header("authorization");
    if (!secret || authorization !== `Bearer ${secret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!effectiveCertificateAuthority) {
      return c.json({ error: "no signing certificate authority" }, 404);
    }

    try {
      const result = await renewSigningCertificates({
        // The key-ring adapter, as for sync-defaults: the tenant's own keys
        // live here without a tenant_id, next to public-only control-plane
        // copies that renewal skips.
        dataAdapter: { keys: encrypted.keys },
        certificateAuthority: effectiveCertificateAuthority,
      });
      return c.json({ renewed: result.renewed, notDue: result.notDue });
    } catch (err) {
      if (err instanceof SigningCertificateRenewalError) {
        console.error(`[wfp-tenant] signing_certificate_renewal_failed:`, err);
        c.header("X-Authhero-Error", "signing_certificate_renewal_failed");
        return c.json(
          {
            error: "signing_certificate_renewal_failed",
            renewed: err.result.renewed,
            notDue: err.result.notDue,
            failed: err.result.failed.map(({ kid, error }) => ({
              kid,
              detail: error instanceof Error ? error.message : String(error),
            })),
          },
          500,
        );
      }
      return errorResponse(c, "signing_certificate_renewal_failed", err);
    }
  });

  app.route("/", authheroApp);

  if (options.inheritanceShadow) {
    // Compare the tenant's own config with what its chain resolves to. Reads
    // the encrypted layer without the fallback, like the colocated reporter.
    const reporter = createShadowReporter(
      encrypted,
      options.inheritanceShadow === true ? {} : options.inheritanceShadow,
    );
    const tenantId =
      env.TENANT_ID || new URL(env.ISSUER).hostname.split(".")[0]!;

    // The worker only holds the tenant's own row and the projected control-plane
    // rows. A parent the row names but this database lacks would cut the chain
    // short and make the comparison report rows as missing that the full chain
    // supplies, so the comparison is skipped until the whole chain is here. (A
    // tenant whose row names no parent is compared with the control plane, the
    // only ancestor the worker can know; for a deeper chain use _Verify_ on the
    // control plane, which resolves it in full.)
    let chainComplete: Promise<boolean> | undefined;
    const hasWholeChain = async (): Promise<boolean> => {
      let current = await encrypted.tenants.get(tenantId);
      for (let depth = 0; depth < 5; depth++) {
        const parent = current?.parent_tenant_id;
        if (!parent || parent === controlPlaneTenantId) return true;
        current = await encrypted.tenants.get(parent);
        if (!current) return false;
      }
      return false;
    };

    shadows.set(app, (request) => {
      // The internal routes are the control plane's own calls, not traffic.
      if (new URL(request.url).pathname.startsWith("/internal/")) return;
      if (tenantId === controlPlaneTenantId) return;
      return (async () => {
        if (!(await (chainComplete ??= hasWholeChain()))) return;
        const comparison = reporter.schedule(tenantId, controlPlaneTenantId);
        if (comparison) await comparison;
      })();
    });
  }

  return app;
}

/** Runs after a response, per app, when shadow mode is on. */
const shadows = new WeakMap<
  Hono,
  (request: Request) => Promise<void> | undefined
>();

/**
 * Builds a WFP tenant worker `{ fetch }` handler: key-ring encryption over the
 * tenant's own D1, runtime fallback for inherited control-plane defaults, the
 * `/internal/sync-defaults` push receiver, and the control-plane issuer gate —
 * all from one factory.
 *
 * Pure push: this worker never calls the control plane at request time. Defaults
 * and the control plane's public verify keys arrive only via
 * `/internal/sync-defaults`. The built app is cached per `env` (one build per
 * isolate).
 */
export function createWfpTenantApp<Env extends WfpTenantEnv = WfpTenantEnv>(
  options: WfpTenantAppOptions<Env>,
): {
  fetch: (
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ) => Promise<Response>;
} {
  const cache = new WeakMap<object, Promise<Hono>>();

  return {
    fetch(request, env, ctx) {
      let appPromise = cache.get(env);
      if (!appPromise) {
        appPromise = buildTenantApp(env, options);
        cache.set(env, appPromise);
      }
      return appPromise.then(async (app) => {
        const response = await app.fetch(request, env, ctx);
        // After the response is built, so it never waits for the comparison.
        const shadow = shadows.get(app)?.(request);
        // Kept alive after the response, so it never delays it.
        if (shadow) ctx.waitUntil(shadow);
        return response;
      });
    },
  };
}
