import {
  authorizedHttpClient,
  createOrganizationHttpClient,
  isSingleTenantForDomain,
} from "@/authProvider";
import {
  buildUrlWithProtocol,
  formatDomain,
  getDomainFromStorage,
  getSelectedDomainFromStorage,
} from "@/utils/domainUtils";
import { getConfigValue } from "@/utils/runtimeConfig";

export interface ActionVerification {
  valid: boolean;
  errors: string[];
}

export const ACTION_GENERATION_MODELS = ["glm", "deepseek", "qwen"] as const;
export type ActionGenerationModel = (typeof ACTION_GENERATION_MODELS)[number];

export interface ActionGeneration {
  models: ActionGenerationModel[];
  /** The server rejects writes that fail static verification. */
  verification_required: boolean;
}

function isActionGenerationModel(
  value: unknown,
): value is ActionGenerationModel {
  return ACTION_GENERATION_MODELS.some((model) => model === value);
}

/**
 * Servers before authhero 9.28 have no generation or verify routes, so a
 * failed request means no generation and no enforced verification.
 */
export async function getActionGeneration(
  tenantId: string,
): Promise<ActionGeneration> {
  try {
    const result = await actionRequest<{
      models?: unknown[];
      verification_required?: boolean;
    }>(tenantId, "generation");
    return {
      models: (result.models ?? []).filter(isActionGenerationModel),
      verification_required: result.verification_required === true,
    };
  } catch {
    return { models: [], verification_required: false };
  }
}

export async function actionRequest<T>(
  tenantId: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const selectedDomain = getSelectedDomainFromStorage();
  const domain = formatDomain(selectedDomain);
  const domainConfig = getDomainFromStorage().find(
    (d) => formatDomain(d.url) === domain,
  );
  const apiUrl = buildUrlWithProtocol(
    domainConfig?.restApiUrl || selectedDomain || getConfigValue("apiUrl"),
  ).replace(/\/$/, "");
  const httpClient = isSingleTenantForDomain(domain)
    ? authorizedHttpClient
    : createOrganizationHttpClient(tenantId);
  const response = await httpClient(
    `${apiUrl}/api/v2/actions/actions/${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: new Headers({
        "tenant-id": tenantId,
        "content-type": "application/json",
      }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return (response as { json: T }).json;
}

export function actionSource(data: Record<string, unknown>) {
  return {
    code: data.code,
    supported_triggers: data.supported_triggers ?? [
      { id: data.trigger_id || "post-login" },
    ],
  };
}

/**
 * Repeat verification on the exact submitted source, including after edits.
 * Only where the server enforces it (an action code generator is configured);
 * elsewhere the server accepts the write and so does the admin.
 */
export async function verifyActionBeforeSave<T extends Record<string, unknown>>(
  data: T,
  tenantId: string,
): Promise<T> {
  if (data.inherit && (typeof data.code !== "string" || !data.code.trim()))
    return data;
  const { verification_required } = await getActionGeneration(tenantId);
  if (!verification_required) return data;
  const result = await actionRequest<ActionVerification>(
    tenantId,
    "verify",
    actionSource(data),
  );
  if (!result.valid)
    throw new Error(`Action verification failed: ${result.errors.join(" ")}`);
  return data;
}
