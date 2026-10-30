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

/** Repeat verification on the exact submitted source, including after edits. */
export async function verifyActionBeforeSave<T extends Record<string, unknown>>(
  data: T,
  tenantId: string,
): Promise<T> {
  if (data.inherit && (typeof data.code !== "string" || !data.code.trim()))
    return data;
  const result = await actionRequest<ActionVerification>(
    tenantId,
    "verify",
    actionSource(data),
  );
  if (!result.valid)
    throw new Error(`Action verification failed: ${result.errors.join(" ")}`);
  return data;
}
