import {
  AnalyticsQueryParams,
  AnalyticsQueryResponse,
  AnalyticsResource,
} from "../types/Analytics";

export interface AnalyticsAdapter {
  /**
   * Run an analytics query for a tenant. The adapter is responsible for
   * injecting the tenant_id predicate; the route handler never trusts a
   * tenant value from a client-controlled source.
   */
  query(
    tenantId: string,
    resource: AnalyticsResource,
    params: AnalyticsQueryParams,
  ): Promise<AnalyticsQueryResponse>;
}
