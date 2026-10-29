import type { TenantMemberRequest } from "@authhero/adapter-interfaces";
import type { TenantMemberRequestStore } from "@authhero/multi-tenancy";
import type { DispatchNamespace } from "../code-executor";
import {
  DEFAULT_SCRIPT_NAME_TEMPLATE,
  fillTemplate,
} from "./dispatch-sync-defaults";

export const TENANT_MEMBER_REQUESTS_PATH = "/internal/tenant-member-requests";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface DispatchTenantMemberRequestStoreOptions {
  /** The dispatch namespace binding the tenant workers live in. */
  dispatcher: DispatchNamespace;
  /** Script-name convention. Supports `{tenant_id}`. */
  scriptNameTemplate?: string;
  /**
   * Shared secret the tenant worker checks on `/internal/*`
   * (`WFP_INTERNAL_SYNC_SECRET`). Sent as a bearer token.
   */
  internalSecret: string;
  /** Per-call timeout. Defaults to 15s. */
  timeoutMs?: number;
}

/**
 * Reaches the team-change requests in a tenant worker's own database, for the
 * `tenant-members-request` operation and its reconcile sweep (issue #1550):
 * read a request, answer it, and list the ones still pending. One endpoint,
 * `POST /internal/tenant-member-requests`, takes the action in its body.
 */
export function createDispatchTenantMemberRequestStore(
  options: DispatchTenantMemberRequestStoreOptions,
): TenantMemberRequestStore {
  const {
    dispatcher,
    scriptNameTemplate = DEFAULT_SCRIPT_NAME_TEMPLATE,
    internalSecret,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  async function call(
    tenantId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const scriptName = fillTemplate(scriptNameTemplate, tenantId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await dispatcher
        .get(scriptName)
        .fetch(`https://tenant.internal${TENANT_MEMBER_REQUESTS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${internalSecret}`,
          },
          body: JSON.stringify({ tenantId, ...body }),
          signal: controller.signal,
        });
    } finally {
      clearTimeout(timer);
    }
  }

  async function failure(tenantId: string, response: Response): Promise<Error> {
    const text = await response.text().catch(() => "");
    const code = response.headers.get("x-authhero-error");
    return new Error(
      `tenant member requests of "${tenantId}" answered ${response.status}` +
        `${code ? ` (${code})` : ""} ${text.slice(0, 256)}`,
    );
  }

  return {
    async get(tenantId, id) {
      const response = await call(tenantId, { action: "get", id });
      if (response.status === 404) return null;
      if (!response.ok) throw await failure(tenantId, response);
      return (await response.json()) as TenantMemberRequest;
    },

    async report(tenantId, id, outcome) {
      const response = await call(tenantId, { action: "report", id, outcome });
      if (!response.ok) throw await failure(tenantId, response);
      return ((await response.json()) as { updated: boolean }).updated;
    },

    async listPending(tenantId, { olderThan }) {
      const response = await call(tenantId, {
        action: "list_pending",
        olderThan,
      });
      if (!response.ok) throw await failure(tenantId, response);
      return ((await response.json()) as { requests: TenantMemberRequest[] })
        .requests;
    },
  };
}
