import { AnalyticsEngineLogsAdapterConfig } from "./types";

interface AnalyticsEngineQueryResponse {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
  data?: Record<string, any>[];
  meta?: {
    name: string;
    type: string;
  }[];
  rows?: number;
  rows_before_limit_at_least?: number;
}

/**
 * Minimal shape the SQL API call needs. Both the logs adapter config and the
 * action-executions adapter config satisfy it, so the helper is shared.
 */
export interface AnalyticsEngineSqlConfig {
  accountId: string;
  apiToken: string;
  timeout?: number;
}

/**
 * Execute a SQL query against Analytics Engine
 */
export async function executeAnalyticsEngineQuery(
  config: AnalyticsEngineSqlConfig | AnalyticsEngineLogsAdapterConfig,
  query: string,
): Promise<Record<string, any>[]> {
  const timeout = config.timeout || 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    // Construct the Cloudflare Analytics Engine SQL API endpoint
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Authorization: `Bearer ${config.apiToken}`,
      },
      body: query,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Analytics Engine query failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const result: AnalyticsEngineQueryResponse = await response.json();

    if (!result.success && result.errors && result.errors.length > 0) {
      throw new Error(
        `Analytics Engine error: ${result.errors.map((e) => e.message).join(", ")}`,
      );
    }

    return result.data || [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Event-count aggregate that stays correct when Analytics Engine samples the
 * dataset.
 *
 * Once a dataset sees enough writes, Analytics Engine keeps only a sample of
 * them and records on each stored row how many original events it stands for
 * in `_sample_interval` (1 for unsampled rows). `count()` counts stored rows,
 * so it under-counts by roughly that factor; summing `_sample_interval` counts
 * events instead. See
 * https://developers.cloudflare.com/analytics/analytics-engine/sampling/
 *
 * With a `condition`, only rows matching it contribute, which replaces the
 * `SUM(CASE WHEN <condition> THEN 1 ELSE 0 END)` pattern.
 *
 * Distinct counts (`COUNT(DISTINCT ...)`) cannot be corrected this way: a
 * value that only appears in rows the sampler dropped is simply missing. Those
 * metrics are approximate (a lower bound) once sampling kicks in.
 */
export function sampledCount(condition?: string): string {
  if (condition === undefined) {
    return "SUM(_sample_interval)";
  }
  return `SUM(CASE WHEN ${condition} THEN _sample_interval ELSE 0 END)`;
}

/**
 * Escape a string value for SQL
 */
export function escapeSQLString(value: string): string {
  return `'${value.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;
}

/**
 * Escape an identifier (table name, column name) for SQL
 * Analytics Engine uses double quotes for identifiers
 */
export function escapeSQLIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
