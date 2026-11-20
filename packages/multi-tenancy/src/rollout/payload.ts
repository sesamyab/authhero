import {
  CreateTenantParams,
  DataAdapters,
  SigningKey,
  Tenant,
  emailProviderSchema,
  brandingSchema,
  promptSettingSchema,
  listControlPlaneKeys,
} from "authhero";
import {
  DefaultsProjectionEntities,
  DefaultsProjectionResult,
  EntityProjectionOutcome,
  ProjectableDefaults,
  attempt,
  emptyOutcome,
  emptyResult,
  isInheritableHook,
  readControlPlaneDefaults,
  resolveDefaultsEntities,
  writeControlPlaneDefaults,
} from "./defaults-projection";
import {
  ApplyResolvedBlockOptions,
  ApplyResolvedBlockResult,
  ResolvedConfigBlock,
  applyResolvedConfigBlock,
} from "./resolved-sync";

/**
 * Entity flags for the wire payload — the six default entities plus signing
 * keys and tenant rows, which only flow through the payload (build + apply),
 * never through the in-process `projectControlPlaneDefaults`.
 */
export type DefaultsPayloadEntities = DefaultsProjectionEntities & {
  signingKeys?: boolean;
  /**
   * Seed the FK-target `tenants` rows into the tenant DB before writing the
   * keyed defaults. Defaults to `true`. See {@link ControlPlaneTenantSeed}.
   */
  tenants?: boolean;
};

/**
 * The tenant-row settings a seed carries into the target tenant's own database
 * (see {@link ControlPlaneTenantSeed.settings}). An allowlist, not "everything
 * but the identity fields": the control plane's copy of the row also holds
 * deployment, provisioning, worker, storage and sync bookkeeping that must stay
 * on the control plane, and a field added to the tenant schema later should not
 * start crossing the boundary without someone deciding it should.
 *
 * Left out on purpose:
 *  - identity / sync / deployment fields (`id`, `audience`, `parent_tenant_id`,
 *    `config_sync*`, `deployment_type`, `provisioning_*`, `worker_*`,
 *    `bundle_configuration`, `storage_kind`, `d1_database_id`,
 *    `database_version`);
 *  - references to entities that live elsewhere (`default_client_id`,
 *    `default_audience`, `default_organization`, `default_directory`);
 *  - informational Auth0 compatibility fields (`sandbox_version*`).
 *
 * `mfa.twilio.auth_token` is a plaintext secret on the tenant row and is
 * stripped (see {@link toSeedSettings}).
 */
export const SEEDED_TENANT_SETTING_KEYS = [
  "picture_url",
  "support_email",
  "support_url",
  "sender_email",
  "sender_name",
  "session_lifetime",
  "idle_session_lifetime",
  "ephemeral_session_lifetime",
  "idle_ephemeral_session_lifetime",
  "session_cookie",
  "allowed_logout_urls",
  "default_redirection_uri",
  "enabled_locales",
  "error_page",
  "flags",
  "change_password",
  "guardian_mfa_page",
  "device_flow",
  "default_token_quota",
  "sessions",
  "oidc_logout",
  "allow_organization_name_in_authentication_api",
  "customize_mfa_in_postlogin_action",
  "acr_values_supported",
  "mtls",
  "pushed_authorization_requests_supported",
  "authorization_response_iss_parameter_supported",
  "attack_protection",
  "mfa",
] as const satisfies readonly (keyof Tenant)[];

export type SeededTenantSettings = Partial<
  Pick<Tenant, (typeof SEEDED_TENANT_SETTING_KEYS)[number]>
>;

/**
 * A `tenants` row the payload carries so the tenant DB has the foreign key
 * targets every other write depends on. D1 enforces the
 * `tenant_id -> tenants(id)` FK, so a freshly provisioned tenant DB (which only
 * has the empty `tenants` table the migrations create) rejects every
 * tenant-scoped insert until these rows exist:
 *
 *  1. the **control-plane tenant id** — the projected defaults
 *     (connections / resource servers / hooks / …) are keyed under it; and
 *  2. the **target tenant's own id** — the tenant's own users / connections /
 *     sessions reference it.
 *
 * The control-plane row is minimal (`id` + `friendly_name`): the FK only needs
 * it to exist, and the control plane's own settings/secrets must not reach a
 * tenant DB. The target tenant's own row also carries that tenant's own
 * settings (`settings`), read off its row in the control plane's DB — that is
 * where `tenantDefaults` were applied on create, so this is how they reach a
 * tenant with its own database. Rows are create-if-missing on apply, so a
 * re-sync never clobbers a row a tenant has since edited (the settings are
 * copied once, like `tenantDefaults` themselves).
 */
export interface ControlPlaneTenantSeed {
  id: string;
  friendly_name: string;
  /**
   * The target tenant's own settings ({@link SEEDED_TENANT_SETTING_KEYS}).
   * Never set on the control-plane tenant's seed. Optional so an older tenant
   * worker ignores it and a newer one accepts a seed without it.
   */
  settings?: SeededTenantSettings;
}

/**
 * Wire shape pushed from a control plane to a tenant database. Transport-
 * agnostic: a Cloudflare dispatch push, an HTTP POST, or an in-process call all
 * carry this same object. Built on the control plane with
 * {@link buildControlPlaneDefaultsPayload} and applied on the tenant with
 * {@link applyControlPlaneDefaultsPayload}.
 */
export interface ControlPlaneDefaultsPayload extends ProjectableDefaults {
  /**
   * Control-plane shared `jwt_signing` keys, PUBLIC material only. Invariant:
   * `pkcs7` (the private key) is stripped on build AND re-stripped on apply, so
   * a private key can never cross the wire or land in a tenant DB. Used to
   * verify tokens the control plane signed (e.g. forwarded admin tokens).
   */
  signingKeys: SigningKey[];
  /**
   * FK-target `tenants` rows upserted into the tenant DB *before* any keyed
   * default, so the `tenant_id -> tenants(id)` FK resolves. See
   * {@link ControlPlaneTenantSeed}.
   */
  tenants: ControlPlaneTenantSeed[];
  /**
   * The tenant's resolved parent-chain config, materialised under the tenant's
   * own id. Optional and opt-in on apply; see {@link ResolvedConfigBlock}.
   */
  resolved?: ResolvedConfigBlock;
}

/** Result of applying a payload — the projection result plus the key/tenant outcomes. */
export interface ControlPlaneDefaultsApplyResult extends DefaultsProjectionResult {
  signingKeys: EntityProjectionOutcome;
  tenants: EntityProjectionOutcome;
  /** Present when a `resolved` block was applied (or dry-run). */
  resolved?: ApplyResolvedBlockResult;
}

/**
 * Strip a control-plane key down to public, control-plane-scoped material: drop
 * `pkcs7` (private key) and `tenant_id` (so it is stored as a shared key that
 * `listControlPlaneKeys` resolves for verification). Used on both build and
 * apply so the public-only invariant holds end to end.
 *
 * Done by omission rather than schema parse: the keys come straight off a DB
 * adapter that emits `null` for absent optional columns, which the full
 * `signingKeySchema` rejects — and the security invariant we care about is
 * "no private material crosses the boundary", which omission guarantees.
 */
function toPublicControlPlaneKey(key: SigningKey): SigningKey {
  const { pkcs7: _pkcs7, tenant_id: _tenantId, ...publicKey } = key;
  return publicKey;
}

/**
 * Reads the control plane's defaults + public signing keys off a control-plane
 * adapter and filters them down to the inheritable, shareable set — the wire
 * payload. Mirrors what `projectControlPlaneDefaults` writes, minus the write.
 *
 * The signing-key selection reuses authhero's `listControlPlaneKeys`
 * (`-_exists_:tenant_id`) so the public-key query has a single source of truth;
 * this layer only strips `pkcs7`.
 */
export async function buildControlPlaneDefaultsPayload(
  controlPlaneAdapters: DataAdapters,
  controlPlaneTenantId: string,
  entities: DefaultsPayloadEntities = {},
  targetTenantId?: string,
): Promise<ControlPlaneDefaultsPayload> {
  const project = resolveDefaultsEntities(entities);
  const includeSigningKeys = entities.signingKeys ?? true;
  const includeTenants = entities.tenants ?? true;

  const data = await readControlPlaneDefaults(
    controlPlaneAdapters,
    controlPlaneTenantId,
    project,
  );

  const signingKeys = includeSigningKeys
    ? (await listControlPlaneKeys(controlPlaneAdapters.keys)).map(
        toPublicControlPlaneKey,
      )
    : [];

  const tenants = includeTenants
    ? await buildTenantSeeds(
        controlPlaneAdapters,
        controlPlaneTenantId,
        targetTenantId,
      )
    : [];

  return {
    connections: data.connections,
    // Filter to the shareable set on the wire (the write side filters too, so
    // this only keeps the payload minimal).
    resourceServers: data.resourceServers.filter((rs) => rs.is_system),
    hooks: data.hooks.filter(isInheritableHook),
    emailProvider: data.emailProvider,
    branding: data.branding,
    promptSettings: data.promptSettings,
    signingKeys,
    tenants,
  };
}

/**
 * The control plane's public signing keys, stripped of private material, as the
 * `sync-config` push carries them. Rotation mints a new `kid`, so sending them
 * with every sync is what lets a tenant keep verifying control-plane tokens
 * after a rotation. Apply them with {@link applyControlPlaneSigningKeys}.
 */
export async function buildControlPlaneSigningKeys(
  controlPlaneAdapters: DataAdapters,
): Promise<SigningKey[]> {
  return (await listControlPlaneKeys(controlPlaneAdapters.keys)).map(
    toPublicControlPlaneKey,
  );
}

/**
 * Picks the allowlisted settings off a tenant row: unknown keys and `null` /
 * `undefined` values (adapters emit `null` for unset columns) are dropped, and
 * `mfa.twilio.auth_token` is stripped. Used on build and again on apply, so a
 * tampered payload can't smuggle other tenant fields into the DB.
 */
function toSeedSettings(
  row: Record<string, unknown> | null | undefined,
): SeededTenantSettings | undefined {
  if (!row) return undefined;
  const settings: Record<string, unknown> = {};
  for (const key of SEEDED_TENANT_SETTING_KEYS) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    settings[key] = value;
  }

  const mfa = settings.mfa;
  if (mfa && typeof mfa === "object" && !Array.isArray(mfa)) {
    const twilio = (mfa as Record<string, unknown>).twilio;
    if (twilio && typeof twilio === "object" && !Array.isArray(twilio)) {
      const { auth_token: _authToken, ...publicTwilio } = twilio as Record<
        string,
        unknown
      >;
      settings.mfa = { ...mfa, twilio: publicTwilio };
    }
  }

  return Object.keys(settings).length > 0
    ? (settings as SeededTenantSettings)
    : undefined;
}

/**
 * Build the FK-target tenant seeds: always the control-plane tenant row, plus
 * the target tenant's own row when a (distinct) `targetTenantId` is given.
 * `friendly_name` is read off the control-plane DB (which holds every tenant's
 * row) and falls back to the id if the row can't be read. Only the target
 * tenant's seed carries `settings`; the control-plane seed stays minimal.
 */
async function buildTenantSeeds(
  controlPlaneAdapters: DataAdapters,
  controlPlaneTenantId: string,
  targetTenantId?: string,
): Promise<ControlPlaneTenantSeed[]> {
  const cpRow = await controlPlaneAdapters.tenants.get(controlPlaneTenantId);
  const seeds: ControlPlaneTenantSeed[] = [
    {
      id: controlPlaneTenantId,
      friendly_name: cpRow?.friendly_name || controlPlaneTenantId,
    },
  ];

  if (targetTenantId && targetTenantId !== controlPlaneTenantId) {
    const row = await controlPlaneAdapters.tenants.get(targetTenantId);
    const settings = toSeedSettings(row);
    seeds.push({
      id: targetTenantId,
      friendly_name: row?.friendly_name || targetTenantId,
      ...(settings ? { settings } : {}),
    });
  }
  return seeds;
}

/**
 * Upserts the public control-plane signing keys into the tenant DB. Keys are
 * stored with NO `tenant_id` (so `listControlPlaneKeys` resolves them) and are
 * create-if-missing by `kid` — rotation mints a new kid, and leaving old public
 * keys behind is harmless. `pkcs7` is re-stripped defensively here too.
 */
export async function applyControlPlaneSigningKeys(
  keys: SigningKey[],
  target: DataAdapters,
  continueOnError: boolean,
): Promise<EntityProjectionOutcome> {
  const outcome = emptyOutcome();
  if (keys.length === 0) return outcome;

  // `KeysAdapter` has no get-by-kid, so list the existing control-plane keys
  // once and dedup against their kids.
  const existing = await listControlPlaneKeys(target.keys);
  const existingKids = new Set(existing.map((k) => k.kid));

  for (const key of keys) {
    await attempt(
      outcome,
      `signing_key ${key.kid}`,
      continueOnError,
      async () => {
        const publicKey = toPublicControlPlaneKey(key);
        if (existingKids.has(publicKey.kid)) return; // create-if-missing
        await target.keys.create(publicKey);
        existingKids.add(publicKey.kid);
        outcome.upserted += 1;
      },
    );
  }

  return outcome;
}

/**
 * Upserts the FK-target tenant rows into the tenant DB. Create-if-missing by id
 * (mirroring the signing-key path): a re-sync leaves an already-present row
 * untouched, so a tenant's own later edits to its row are never clobbered. Only
 * `id`, `friendly_name` and the allowlisted `settings` are written (re-filtered
 * here), so a tampered payload can't smuggle other tenant fields into the DB.
 * The control-plane tenant's row never takes settings, even if a payload sends
 * them.
 */
async function applyControlPlaneTenantSeeds(
  seeds: ControlPlaneTenantSeed[],
  target: DataAdapters,
  controlPlaneTenantId: string,
  continueOnError: boolean,
): Promise<EntityProjectionOutcome> {
  const outcome = emptyOutcome();
  for (const seed of seeds) {
    await attempt(outcome, `tenant ${seed.id}`, continueOnError, async () => {
      const existing = await target.tenants.get(seed.id);
      if (existing) return; // create-if-missing
      const settings =
        seed.id === controlPlaneTenantId
          ? undefined
          : toSeedSettings(seed.settings as Record<string, unknown>);
      await target.tenants.create({
        ...settings,
        id: seed.id,
        friendly_name: seed.friendly_name,
      } as CreateTenantParams);
      outcome.upserted += 1;
    });
  }
  return outcome;
}

/**
 * Applies a control-plane defaults payload to a tenant's own adapter, writing
 * the rows under `controlPlaneTenantId` so the runtime fallback resolves them
 * locally. Reuses the same upsert/filter path as `projectControlPlaneDefaults`
 * (via `writeControlPlaneDefaults`) and adds the dedicated signing-key path.
 *
 * The payload is a trust boundary: every singleton is re-parsed with its schema
 * and signing keys are re-stripped of `pkcs7` before anything is written.
 *
 * `result.tenantId` is the control-plane tenant id the rows are keyed under
 * (the target adapter already _is_ the tenant's database).
 */
export async function applyControlPlaneDefaultsPayload(
  payload: ControlPlaneDefaultsPayload,
  targetAdapters: DataAdapters,
  controlPlaneTenantId: string,
  options: {
    continueOnError?: boolean;
    entities?: DefaultsPayloadEntities;
    /**
     * Also apply the payload's `resolved` block to `tenantId`. Without this the
     * block is ignored, so existing callers are unaffected.
     */
    resolved?: ApplyResolvedBlockOptions & { tenantId: string };
  } = {},
): Promise<ControlPlaneDefaultsApplyResult> {
  const continueOnError = options.continueOnError ?? false;
  const project = resolveDefaultsEntities(options.entities);
  const includeSigningKeys = options.entities?.signingKeys ?? true;
  const includeTenants = options.entities?.tenants ?? true;

  // Re-validate the payload at the trust boundary. Connections / resource
  // servers / hooks are parsed inside writeControlPlaneDefaults via their insert
  // schemas; the singletons are parsed here.
  const data: ProjectableDefaults = {
    connections: payload.connections,
    resourceServers: payload.resourceServers,
    hooks: payload.hooks,
    emailProvider: payload.emailProvider
      ? emailProviderSchema.parse(payload.emailProvider)
      : null,
    branding: payload.branding ? brandingSchema.parse(payload.branding) : null,
    promptSettings: payload.promptSettings
      ? promptSettingSchema.parse(payload.promptSettings)
      : null,
  };

  // Seed the FK-target tenant rows FIRST — every keyed default below references
  // `tenants(id)`, so without these rows the upserts FK-fail (silently, when
  // continueOnError is set).
  const tenants = includeTenants
    ? await applyControlPlaneTenantSeeds(
        payload.tenants ?? [],
        targetAdapters,
        controlPlaneTenantId,
        continueOnError,
      )
    : emptyOutcome();

  const result = emptyResult(controlPlaneTenantId);
  await writeControlPlaneDefaults(
    data,
    targetAdapters,
    controlPlaneTenantId,
    project,
    continueOnError,
    result,
  );

  const signingKeys = includeSigningKeys
    ? await applyControlPlaneSigningKeys(
        payload.signingKeys,
        targetAdapters,
        continueOnError,
      )
    : emptyOutcome();

  // Applied last: the tenant row is seeded above, which the sync hash needs.
  const resolved =
    payload.resolved && options.resolved
      ? await applyResolvedConfigBlock(
          payload.resolved,
          targetAdapters,
          options.resolved.tenantId,
          { continueOnError, ...options.resolved },
        )
      : undefined;

  return { ...result, signingKeys, tenants, ...(resolved ? { resolved } : {}) };
}
