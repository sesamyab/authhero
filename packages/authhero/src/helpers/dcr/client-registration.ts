import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  isPlainObject,
  type Client,
  type ClientInsert,
  type ClientRegistrationToken,
  type Tenant,
} from "@authhero/adapter-interfaces";
import type { Bindings, Variables } from "../../types";
import { JSONHTTPException } from "../../errors/json-http-exception";
import { mintRegistrationToken } from "./mint-token";
import { deepEqual, enforceConstraints } from "./constraint-enforcement";
import { isRegistrationDeniedAudience } from "./audience-policy";
import {
  clientToDcrResponse,
  dcrRequestSchema,
  dcrRequestToClient,
  type DcrRequest,
  type DcrResponse,
} from "./metadata-mapping";
import {
  clientPreset,
  isAppPreset,
  readOperatorConstraints,
  type AppPreset,
} from "./presets";
import {
  FORBIDDEN_SCHEMES,
  checkUris,
  describeUriViolation,
  type UriField,
  type UriViolation,
} from "./uri-policy";
import {
  generateClientId,
  generateClientSecret,
  requireClientRegistrationTokens,
} from "../../routes/auth-api/register/shared";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

/** RFC 7591 §2: `grant_types` defaults to `authorization_code` when omitted. */
const DEFAULT_GRANT_TYPES = ["authorization_code"];

/** Registration access tokens of invite-created apps expire after 7 days. */
export const INVITE_REGISTRATION_ACCESS_TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * A rejected registration or update. `field` names the metadata field at
 * fault (in wire form) so the setup page can show the error next to it.
 */
export class DcrMetadataError extends JSONHTTPException {
  readonly field?: string;
  readonly description: string;
  /** Set when a URL broke the developer URL rules (see uri-policy.ts). */
  readonly uriViolation?: UriViolation;

  constructor(
    error: string,
    description: string,
    field?: string,
    status: ContentfulStatusCode = 400,
    uriViolation?: UriViolation,
  ) {
    super(status, { error, error_description: description });
    this.field = field;
    this.description = description;
    this.uriViolation = uriViolation;
  }
}

export function readIatConstraints(
  registrationMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!registrationMetadata) return undefined;
  const value = registrationMetadata.iat_constraints;
  return isPlainObject(value) ? value : undefined;
}

/**
 * Baseline check for every registration: an absolute URL, with a host for
 * http(s); a private-use scheme (`com.example.app:/callback`, RFC 8252 §7.1)
 * needs none. Script and data schemes are never a redirect target.
 */
function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (FORBIDDEN_SCHEMES.has(parsed.protocol)) return false;
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return Boolean(parsed.host);
  }
  return true;
}

function validateRedirectUris(uris: string[] | undefined) {
  if (!uris) return;
  for (const u of uris) {
    const valid = isValidRedirectUri(u);
    if (!valid) {
      throw new DcrMetadataError(
        "invalid_redirect_uri",
        `Invalid redirect_uri: ${u}`,
        "redirect_uris",
      );
    }
  }
}

function validateGrantTypesAllowed(
  requested: string[] | undefined,
  allowlist: string[] | undefined,
) {
  if (!requested || !allowlist || allowlist.length === 0) return;
  for (const gt of requested) {
    if (!allowlist.includes(gt)) {
      throw new DcrMetadataError(
        "invalid_client_metadata",
        `grant_type "${gt}" is not allowed for this tenant`,
        "grant_types",
      );
    }
  }
}

/**
 * Request fields that provision API access (a client_grants row). Only the
 * operator may set them, by pinning them on the Initial Access Token; the
 * registrant may repeat a pinned value but never choose one.
 */
const GRANT_FIELDS = ["audience", "scope"] as const;

function assertGrantFieldsPinned(
  request: Readonly<Record<string, unknown>>,
  constraints: Record<string, unknown> | undefined,
) {
  for (const field of GRANT_FIELDS) {
    if (request[field] !== undefined && constraints?.[field] === undefined) {
      throw new DcrMetadataError(
        "invalid_client_metadata",
        `Field "${field}" can only be set by an Initial Access Token constraint`,
        field,
      );
    }
  }
}

interface DcrAudienceGrant {
  audience: string;
  scopes: string[];
}

/**
 * Resolve the IAT-pinned `audience` + `scope` into a validated grant spec.
 * Returns `null` if no audience was pinned (no grant to provision). Callers
 * must run `assertGrantFieldsPinned` first, so these values always come from
 * the operator, never from the registrant.
 *
 * Rejects with 400 when the audience is one registration may never grant
 * (the Management API), does not match a resource server on the tenant, or
 * when a scope is not defined on that resource server. Mirrors the
 * validation in `/connect/start`.
 */
async function resolveAudienceGrant(
  ctx: Ctx,
  audience: string | undefined,
  scope: string | undefined,
): Promise<DcrAudienceGrant | null> {
  if (!audience) {
    if (scope) {
      throw new DcrMetadataError(
        "invalid_client_metadata",
        "scope requires audience",
        "scope",
      );
    }
    return null;
  }

  if (await isRegistrationDeniedAudience(ctx, ctx.var.tenant_id, audience)) {
    throw new DcrMetadataError(
      "invalid_client_metadata",
      `Audience cannot be granted through Dynamic Client Registration: ${audience}`,
      "audience",
    );
  }

  const { resource_servers } = await ctx.env.data.resourceServers.list(
    ctx.var.tenant_id,
  );
  const resourceServer = resource_servers.find(
    (rs) => rs.identifier === audience,
  );
  if (!resourceServer) {
    throw new DcrMetadataError(
      "invalid_client_metadata",
      `Unknown audience: ${audience}`,
      "audience",
    );
  }

  const scopes = scope ? scope.split(/\s+/).filter(Boolean) : [];
  if (scopes.length > 0) {
    const definedScopes = new Set(
      (resourceServer.scopes ?? []).map((s) => s.value),
    );
    const unknown = scopes.filter((s) => !definedScopes.has(s));
    if (unknown.length > 0) {
      throw new DcrMetadataError(
        "invalid_scope",
        `Scope(s) not defined on the resource server: ${unknown.join(", ")}`,
        "scope",
      );
    }
  }

  return { audience, scopes };
}

const URI_FIELDS: UriField[] = [
  "redirect_uris",
  "post_logout_redirect_uris",
  "web_origins",
];

function assertUriPolicy(
  appType: AppPreset,
  request: Pick<DcrRequest, UriField>,
  existing: Partial<Record<UriField, string[]>> = {},
) {
  for (const field of URI_FIELDS) {
    const violation = checkUris(
      field,
      request[field],
      appType,
      existing[field],
    );
    if (violation) {
      throw new DcrMetadataError(
        field === "redirect_uris"
          ? "invalid_redirect_uri"
          : "invalid_client_metadata",
        describeUriViolation(violation),
        field,
        400,
        violation,
      );
    }
  }
}

function assertRedirectUrisForCodeFlow(
  grantTypes: string[] | undefined,
  redirectUris: string[] | undefined,
) {
  if (
    grantTypes?.some(
      (gt) => gt === "authorization_code" || gt === "implicit",
    ) &&
    (!redirectUris || redirectUris.length === 0)
  ) {
    throw new DcrMetadataError(
      "invalid_redirect_uri",
      "redirect_uris is required for authorization_code and implicit grant types",
      "redirect_uris",
    );
  }
}

function parseMergedRequest(filled: Record<string, unknown>): DcrRequest {
  const parsed = dcrRequestSchema.safeParse(filled);
  if (!parsed.success) {
    throw new DcrMetadataError(
      "invalid_client_metadata",
      "Merged request (with IAT constraints applied) is not valid RFC 7591 metadata",
    );
  }
  return parsed.data;
}

export interface RegisterClientOptions {
  /**
   * Return a registration access token, as `POST /oidc/register` does. The
   * setup page does not: the developer gets no standing access and asks the
   * operator for an edit link instead.
   */
  issueRegistrationAccessToken: boolean;
}

export interface RegisteredClient {
  client: Client;
  /** Only for confidential clients; shown once. */
  client_secret?: string;
  registration_access_token?: string;
}

/**
 * RFC 7591 registration shared by `POST /oidc/register` and the developer
 * setup page. `iat` is the authenticated Initial Access Token, or undefined
 * for open registration. The token is marked used in the same transaction
 * that creates the client.
 */
export async function registerClient(
  ctx: Ctx,
  tenant: Tenant,
  iat: ClientRegistrationToken | undefined,
  body: DcrRequest,
  options: RegisterClientOptions,
): Promise<RegisteredClient> {
  // API access is only provisioned when the operator pinned it on the IAT.
  assertGrantFieldsPinned(body, iat?.constraints);

  // Enforce IAT pre-bound constraints against the raw request body
  // (before RFC -> Client mapping) so constraint keys stay in wire form.
  const constraintResult = enforceConstraints(iat?.constraints, body);
  if (!constraintResult.ok) {
    const field = constraintResult.violation?.field;
    throw new DcrMetadataError(
      "invalid_client_metadata",
      `Field "${field}" conflicts with Initial Access Token constraint`,
      field,
    );
  }
  const request = parseMergedRequest(constraintResult.filled);

  // An omitted grant_types is stored as the default, so validate that.
  const effectiveGrantTypes = request.grant_types ?? DEFAULT_GRANT_TYPES;
  assertRedirectUrisForCodeFlow(effectiveGrantTypes, request.redirect_uris);
  validateRedirectUris(request.redirect_uris);
  validateGrantTypesAllowed(
    effectiveGrantTypes,
    tenant.flags?.dcr_allowed_grant_types,
  );

  const operator = readOperatorConstraints(iat?.constraints);
  if (operator.app_type) {
    assertUriPolicy(operator.app_type, request);
  }

  const audienceGrant = await resolveAudienceGrant(
    ctx,
    request.audience,
    request.scope,
  );

  const { clientFields, extraMetadata } = dcrRequestToClient(request);

  const client_id = generateClientId();
  const tokenEndpointAuthMethod =
    clientFields.token_endpoint_auth_method ?? "client_secret_basic";
  // Public clients authenticate with PKCE only; never mint a secret for them.
  const client_secret =
    tokenEndpointAuthMethod === "none" ? undefined : generateClientSecret();

  const rat = options.issueRegistrationAccessToken
    ? await mintRegistrationToken()
    : undefined;

  const registration_metadata: Record<string, unknown> = {
    ...extraMetadata,
  };
  delete registration_metadata.iat_constraints;
  if (iat?.constraints) {
    registration_metadata.iat_constraints = iat.constraints;
  }
  if (iat) {
    registration_metadata.registration_token_id = iat.id;
  }

  const clientInsert: ClientInsert = {
    client_id,
    name: clientFields.name ?? `Client ${client_id.slice(0, 8)}`,
    ...(client_secret ? { client_secret } : {}),
    callbacks: clientFields.callbacks ?? [],
    allowed_logout_urls: clientFields.allowed_logout_urls ?? [],
    web_origins: clientFields.web_origins ?? [],
    grant_types: clientFields.grant_types ?? DEFAULT_GRANT_TYPES,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    logo_uri: clientFields.logo_uri,
    client_metadata: clientFields.client_metadata,
    owner_user_id: iat?.sub,
    registration_type: iat ? "iat_dcr" : "open_dcr",
    registration_metadata,
    // DCR clients are RFC-compliant by definition — no Auth0-SDK quirks
    // to preserve. Opt out of Auth0-compat token-endpoint behaviors
    // (e.g. 403 for invalid_grant) so we return RFC 6749 §5.2's 400.
    auth0_conformant: false,
  };
  const appType = operator.app_type ?? clientFields.app_type;
  if (appType) {
    clientInsert.app_type = appType;
  }
  if (operator.is_first_party !== undefined) {
    clientInsert.is_first_party = operator.is_first_party;
  }

  let createdClient: Client | undefined;

  await ctx.env.data.transaction(async (trx) => {
    const trxTokens = requireClientRegistrationTokens(trx);
    if (iat) {
      const marked = await trxTokens.markUsed(
        ctx.var.tenant_id,
        iat.id,
        new Date().toISOString(),
        client_id,
      );
      if (!marked) {
        throw new DcrMetadataError(
          "invalid_token",
          "Initial access token already used",
          undefined,
          401,
        );
      }
    }

    createdClient = await trx.clients.create(ctx.var.tenant_id, clientInsert);

    if (audienceGrant) {
      await trx.clientGrants.create(ctx.var.tenant_id, {
        client_id,
        audience: audienceGrant.audience,
        scope: audienceGrant.scopes,
      });
    }

    if (operator.connections && operator.connections.length > 0) {
      await trx.clientConnections.updateByClient(
        ctx.var.tenant_id,
        client_id,
        operator.connections,
      );
    }

    if (rat) {
      await trxTokens.create(ctx.var.tenant_id, {
        id: rat.id,
        token_hash: rat.token_hash,
        type: "rat",
        client_id,
        single_use: false,
        source: "registration",
        ...(iat?.source === "invite"
          ? {
              expires_at: new Date(
                Date.now() + INVITE_REGISTRATION_ACCESS_TOKEN_TTL_SEC * 1000,
              ).toISOString(),
            }
          : {}),
      });
    }
  });

  if (!createdClient) {
    throw new DcrMetadataError(
      "server_error",
      "Failed to create client",
      undefined,
      500,
    );
  }

  return {
    client: createdClient,
    client_secret,
    registration_access_token: rat?.token,
  };
}

/**
 * Fields an outside developer may change after registration, through an edit
 * link or (for invite-created apps) RFC 7592. Everything else stays as the
 * operator configured it.
 */
export const EDITABLE_FIELDS = [
  "client_name",
  "logo_uri",
  "redirect_uris",
  "post_logout_redirect_uris",
  "web_origins",
  "client_uri",
  "policy_uri",
  "tos_uri",
  "contacts",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

const EDITABLE = new Set<string>(EDITABLE_FIELDS);
/** Accepted in a PUT body but never applied (RFC 7592 §2.2). */
const IGNORED_ON_UPDATE = new Set(["client_id", "client_secret"]);

const METADATA_URL_FIELDS = ["client_uri", "tos_uri", "policy_uri"] as const;

export interface UpdateRegisteredClientOptions {
  /**
   * Restrict the update to `EDITABLE_FIELDS`: other fields must be omitted
   * (kept as stored) or equal to the stored value. Used for edit links and
   * for every app created from an invite preset.
   */
  editableFieldsOnly: boolean;
}

export interface UpdatedClient {
  client: Client;
  /** Wire names of the editable fields whose value changed. */
  changed: string[];
}

/** The app type whose URL rules apply when editing `client`. */
export function editPolicyAppType(client: Client): AppPreset {
  const preset = clientPreset(client.registration_metadata);
  if (preset) return preset;
  return isAppPreset(client.app_type) ? client.app_type : "regular_web";
}

/**
 * RFC 7592 update shared by `PUT /oidc/register/{client_id}` and the
 * developer setup page.
 */
export async function updateRegisteredClient(
  ctx: Ctx,
  tenant: Tenant,
  existing: Client,
  body: DcrRequest,
  options: UpdateRegisteredClientOptions,
): Promise<UpdatedClient> {
  const iatConstraints = readIatConstraints(existing.registration_metadata);
  let request: DcrRequest = body;
  if (iatConstraints) {
    const check = enforceConstraints(iatConstraints, body);
    if (!check.ok) {
      const field = check.violation?.field;
      throw new DcrMetadataError(
        "invalid_client_metadata",
        `Field "${field}" was bound at registration time and cannot be changed`,
        field,
      );
    }
    // Build the update from the constraint-filled request, so a constrained
    // field the caller omits keeps its bound value instead of being reset.
    request = parseMergedRequest(check.filled);
  }

  validateRedirectUris(request.redirect_uris);

  if (options.editableFieldsOnly) {
    return updateEditableFields(ctx, existing, body);
  }

  validateGrantTypesAllowed(
    request.grant_types ?? DEFAULT_GRANT_TYPES,
    tenant.flags?.dcr_allowed_grant_types,
  );

  const { clientFields, extraMetadata } = dcrRequestToClient(request);

  // Preserve iat_constraints and provenance across PUT (replace semantics on
  // everything else).
  const mergedMetadata: Record<string, unknown> = { ...extraMetadata };
  if (iatConstraints) {
    mergedMetadata.iat_constraints = iatConstraints;
  }
  const registrationTokenId =
    existing.registration_metadata?.registration_token_id;
  if (registrationTokenId !== undefined) {
    mergedMetadata.registration_token_id = registrationTokenId;
  }

  // RFC 7592 §2.2 replace semantics: set every standard registration field
  // explicitly so omitted fields are reset to their RFC 7591 default (or
  // cleared) rather than carrying over the previous value. Fields mapped
  // into client_metadata (client_uri, tos_uri, policy_uri, jwks_uri,
  // contacts, scope, software_id, software_version) and
  // registration_metadata (response_types, jwks) are replaced wholesale by
  // the freshly-built objects below. client_secret is intentionally omitted
  // — RFC 7592 PUT must not rotate it. Logout URLs, web origins and the app
  // type are only touched when sent, since older callers could not set them.
  const update: Partial<Client> = {
    name: clientFields.name ?? `Client ${existing.client_id.slice(0, 8)}`,
    callbacks: clientFields.callbacks ?? [],
    grant_types: clientFields.grant_types ?? DEFAULT_GRANT_TYPES,
    token_endpoint_auth_method:
      clientFields.token_endpoint_auth_method ?? "client_secret_basic",
    logo_uri: clientFields.logo_uri,
    client_metadata: clientFields.client_metadata ?? {},
    registration_metadata: mergedMetadata,
    ...(clientFields.allowed_logout_urls !== undefined
      ? { allowed_logout_urls: clientFields.allowed_logout_urls }
      : {}),
    ...(clientFields.web_origins !== undefined
      ? { web_origins: clientFields.web_origins }
      : {}),
    ...(clientFields.app_type !== undefined
      ? { app_type: clientFields.app_type }
      : {}),
  };

  return {
    client: await writeUpdate(ctx, existing.client_id, update),
    changed: [],
  };
}

async function updateEditableFields(
  ctx: Ctx,
  existing: Client,
  body: DcrRequest,
): Promise<UpdatedClient> {
  const current: DcrResponse = clientToDcrResponse(existing, {
    registration_client_uri: "",
    include_client_secret: false,
  });

  for (const [key, value] of Object.entries(body)) {
    if (
      value === undefined ||
      EDITABLE.has(key) ||
      IGNORED_ON_UPDATE.has(key)
    ) {
      continue;
    }
    const stored: unknown = Object.entries(current).find(
      ([currentKey]) => currentKey === key,
    )?.[1];
    if (!deepEqual(value, stored)) {
      throw new DcrMetadataError(
        "invalid_client_metadata",
        `Field "${key}" cannot be changed`,
        key,
      );
    }
  }

  assertRedirectUrisForCodeFlow(existing.grant_types, body.redirect_uris);
  assertUriPolicy(editPolicyAppType(existing), body, {
    redirect_uris: existing.callbacks ?? [],
    post_logout_redirect_uris: existing.allowed_logout_urls ?? [],
    web_origins: existing.web_origins ?? [],
  });

  const metadata: Record<string, string> = {
    ...(existing.client_metadata ?? {}),
  };
  for (const key of METADATA_URL_FIELDS) {
    const value = body[key];
    if (value) {
      metadata[key] = value;
    } else {
      delete metadata[key];
    }
  }
  if (body.contacts && body.contacts.length > 0) {
    metadata.contacts = body.contacts.join(",");
  } else {
    delete metadata.contacts;
  }

  const update: Partial<Client> = {
    name: body.client_name ?? existing.name,
    callbacks: body.redirect_uris ?? [],
    allowed_logout_urls: body.post_logout_redirect_uris ?? [],
    web_origins: body.web_origins ?? [],
    client_metadata: metadata,
    // Through a link the logo can be replaced, not removed: adapters treat an
    // undefined field as "unchanged".
    ...(body.logo_uri ? { logo_uri: body.logo_uri } : {}),
  };

  const client = await writeUpdate(ctx, existing.client_id, update);
  const after = clientToDcrResponse(client, {
    registration_client_uri: "",
    include_client_secret: false,
  });
  const changed = EDITABLE_FIELDS.filter(
    (field) => !deepEqual(current[field], after[field]),
  );
  return { client, changed };
}

async function writeUpdate(
  ctx: Ctx,
  client_id: string,
  update: Partial<Client>,
): Promise<Client> {
  const ok = await ctx.env.data.clients.update(
    ctx.var.tenant_id,
    client_id,
    update,
  );
  if (!ok) {
    throw new DcrMetadataError(
      "server_error",
      "Failed to update client",
      undefined,
      500,
    );
  }
  const updated = await ctx.env.data.clients.get(ctx.var.tenant_id, client_id);
  if (!updated) {
    throw new DcrMetadataError(
      "server_error",
      "Failed to read back updated client",
      undefined,
      500,
    );
  }
  return updated;
}

/**
 * Whether RFC 7592 updates to this client are limited to `EDITABLE_FIELDS`:
 * always through an edit link, and for every app created from an invite
 * preset.
 */
export function updatesRestrictedToEditableFields(
  client: Client,
  token: ClientRegistrationToken,
): boolean {
  return (
    token.source === "edit_link" ||
    clientPreset(client.registration_metadata) !== undefined
  );
}
