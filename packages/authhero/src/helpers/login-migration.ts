import { Client, DataAdapters, Tenant } from "@authhero/adapter-interfaces";
import { LoginRoutePrefix, resolveLoginRoutePrefix } from "./login-version";
import {
  clientLegalUrls,
  withTenantLegalDefaults,
} from "../routes/universal-login/legal-links";

/**
 * Tooling for moving tenants from the classic login (/u) to the widget login
 * (/u2). Adapter-agnostic so the CLI in `scripts/login-migration.ts` can run
 * it against any database.
 */

export type LoginMigrationData = Pick<
  DataAdapters,
  | "tenants"
  | "clients"
  | "promptSettings"
  | "themes"
  | "branding"
  | "universalLoginTemplates"
  | "customText"
  | "promptPartials"
>;

export type CheckStatus = "ok" | "warn" | "info";

export interface LoginMigrationCheck {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface LoginMigrationClient {
  client_id: string;
  name: string;
  override?: string;
  prefix: LoginRoutePrefix;
}

export interface LoginMigrationReport {
  tenant_id: string;
  /** The tenant flag `flags.universal_login_version`, if set. */
  tenant_version?: string;
  clients: LoginMigrationClient[];
  /** Clients that resolve to /u today. */
  unmigrated: number;
  checks: LoginMigrationCheck[];
}

const PAGE_SIZE = 100;

export async function listAllClients(
  data: Pick<DataAdapters, "clients">,
  tenantId: string,
): Promise<Client[]> {
  const all: Client[] = [];
  for (let page = 0; ; page++) {
    const { clients } = await data.clients.list(tenantId, {
      page,
      per_page: PAGE_SIZE,
    });
    all.push(...clients);
    if (clients.length < PAGE_SIZE) return all;
  }
}

export async function listAllTenants(
  data: Pick<DataAdapters, "tenants">,
): Promise<Tenant[]> {
  const all: Tenant[] = [];
  for (let page = 0; ; page++) {
    const { tenants } = await data.tenants.list({ page, per_page: PAGE_SIZE });
    all.push(...tenants);
    if (tenants.length < PAGE_SIZE) return all;
  }
}

async function getTenant(
  data: Pick<DataAdapters, "tenants">,
  tenantId: string,
): Promise<Tenant> {
  const tenant = await data.tenants.get(tenantId);
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`);
  return tenant;
}

function override(client: Client): string | undefined {
  const value = client.client_metadata?.universal_login_version;
  return value === undefined || value === "" ? undefined : String(value);
}

/** How each of a tenant's clients resolves today. */
export function resolveTenantClients(
  tenant: Tenant,
  clients: Client[],
): LoginMigrationClient[] {
  return clients.map((client) => ({
    client_id: client.client_id,
    name: client.name,
    override: override(client),
    prefix: resolveLoginRoutePrefix({ ...client, tenant }),
  }));
}

export async function auditLoginMigration(
  data: LoginMigrationData,
  tenantId: string,
): Promise<LoginMigrationReport> {
  const [
    tenant,
    settings,
    clients,
    theme,
    branding,
    template,
    customText,
    partials,
  ] = await Promise.all([
    getTenant(data, tenantId),
    data.promptSettings.get(tenantId),
    listAllClients(data, tenantId),
    data.themes.get(tenantId, "default"),
    data.branding.get(tenantId),
    data.universalLoginTemplates.get(tenantId),
    data.customText.list(tenantId),
    data.promptPartials?.list(tenantId) ?? Promise.resolve([]),
  ]);

  const tenantVersion = tenant.flags?.universal_login_version;
  const reportClients = resolveTenantClients(tenant, clients);
  const unmigrated = reportClients.filter((c) => c.prefix === "/u");
  const checks: LoginMigrationCheck[] = [];

  checks.push(
    tenantVersion === "2"
      ? { id: "tenant_setting", status: "ok", message: "Tenant uses /u2." }
      : {
          id: "tenant_setting",
          status: "warn",
          message: `Tenant is on /u (flags.universal_login_version ${tenantVersion ?? "unset"}). Run \`flip\` to move it to /u2.`,
        },
  );

  const pinnedClassic = reportClients.filter((c) => c.override === "1");
  if (pinnedClassic.length > 0) {
    checks.push({
      id: "client_overrides",
      status: "warn",
      message: `${pinnedClassic.length} client(s) pinned to /u: ${pinnedClassic
        .map((c) => c.client_id)
        .join(", ")}. Clear their override after testing them on /u2.`,
    });
  }
  const unknownOverrides = reportClients.filter(
    (c) => c.override && c.override !== "1" && c.override !== "2",
  );
  if (unknownOverrides.length > 0) {
    checks.push({
      id: "client_overrides_unknown",
      status: "warn",
      message: `${unknownOverrides.length} client(s) have an unrecognised universal_login_version (${unknownOverrides
        .map((c) => `${c.client_id}=${c.override}`)
        .join(", ")}); they follow the tenant setting.`,
    });
  }

  checks.push(
    theme
      ? { id: "theme", status: "ok", message: "A default theme is stored." }
      : {
          id: "theme",
          status: "warn",
          message:
            "No stored theme: /u2 renders the built-in default theme. Check the look before flipping.",
        },
  );

  const customPages = clients.filter(
    (c) => c.custom_login_page_on || c.custom_login_page || c.form_template,
  );
  if (customPages.length > 0) {
    checks.push({
      id: "custom_pages",
      status: "warn",
      message: `${customPages.length} client(s) have a custom login page or form template (${customPages
        .map((c) => c.client_id)
        .join(", ")}). /u2 does not render these.`,
    });
  }
  if (template) {
    checks.push({
      id: "universal_login_template",
      status: "warn",
      message:
        "The tenant has a universal login template. Only /u2 renders it, so it takes effect on flip. Review it.",
    });
  }

  checks.push({
    id: "prompt_settings",
    status: "info",
    message: `identifier_first=${settings.identifier_first}, password_first=${settings.password_first}.`,
  });
  if (customText.length > 0 || partials.length > 0) {
    checks.push({
      id: "customizations",
      status: "info",
      message: `${customText.length} custom text entr${customText.length === 1 ? "y" : "ies"}, ${partials.length} prompt partial(s). Review them on /u2.`,
    });
  }

  const missingTerms = clients.filter(
    (c) =>
      !withTenantLegalDefaults(
        clientLegalUrls(
          c.client_metadata as Record<string, string | undefined> | undefined,
        ),
        branding,
      ).termsAndConditionsUrl,
  );
  checks.push(
    missingTerms.length === 0
      ? {
          id: "terms_url",
          status: "ok",
          message: "Every client has a terms URL.",
        }
      : {
          id: "terms_url",
          status: "warn",
          message: `${missingTerms.length} client(s) have no terms URL (client tos_uri/termsAndConditionsUrl or branding.terms_url).`,
        },
  );

  return {
    tenant_id: tenantId,
    tenant_version: tenantVersion,
    clients: reportClients,
    unmigrated: unmigrated.length,
    checks,
  };
}

/**
 * Probes whether the widget bundle is served from a deployment. The database
 * can't tell whether `widgetHandler` is mounted, and deployments that ship the
 * bundle as static assets have no handler at all.
 */
export async function checkWidgetServed(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoginMigrationCheck> {
  const url = new URL("/widget/authhero-widget.esm.js", baseUrl).toString();
  try {
    const response = await fetchFn(url, { redirect: "follow" });
    return response.ok
      ? { id: "widget", status: "ok", message: `Widget served at ${url}.` }
      : {
          id: "widget",
          status: "warn",
          message: `Widget not served at ${url} (HTTP ${response.status}). Mount widgetHandler or ship the bundle.`,
        };
  } catch (err) {
    return {
      id: "widget",
      status: "warn",
      message: `Widget probe failed for ${url}: ${(err as Error).message}`,
    };
  }
}

export interface SetTenantVersionResult {
  tenant_id: string;
  from?: string;
  to?: string;
  /** Clients pinned to /u by a "1" override, which stay on /u. */
  pinned: string[];
}

/**
 * Sets (or with `undefined`, removes) the tenant flag
 * `flags.universal_login_version`. Client overrides are left untouched, so a
 * rollback restores exactly what the tenant had.
 */
export async function setTenantLoginVersion(
  data: Pick<LoginMigrationData, "tenants" | "clients">,
  tenantId: string,
  version: "1" | "2" | undefined,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<SetTenantVersionResult> {
  const [tenant, clients] = await Promise.all([
    getTenant(data, tenantId),
    listAllClients(data, tenantId),
  ]);
  const { universal_login_version: from, ...otherFlags } = tenant.flags ?? {};

  if (!dryRun) {
    // Adapters replace `flags` as a whole, so write the other flags back.
    await data.tenants.update(tenantId, {
      flags: version
        ? { ...otherFlags, universal_login_version: version }
        : otherFlags,
    });
  }

  return {
    tenant_id: tenantId,
    from,
    to: version,
    pinned: clients.filter((c) => override(c) === "1").map((c) => c.client_id),
  };
}
