import { nanoid } from "nanoid";
import {
  TenantsDataAdapter,
  Tenant,
  CreateTenantParams,
  Totals,
  tenantSchema,
  tokenizeLuceneQuery,
  unquoteLuceneValue,
} from "@authhero/adapter-interfaces";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { tenantKeys } from "../keys";
import {
  getItem,
  putItem,
  deleteItem,
  queryWithPagination,
  isKeysetRequest,
  updateItem,
  stripDynamoDBFields,
  removeNullProperties,
} from "../utils";

interface TenantItem
  extends DynamoDBBaseItem, Omit<Tenant, "created_at" | "updated_at"> {
  GSI1PK: string;
  GSI1SK: string;
}

function toTenant(item: TenantItem): Tenant {
  const stripped = stripDynamoDBFields(item);
  return tenantSchema.parse(removeNullProperties(stripped));
}

export function createTenantsAdapter(ctx: DynamoDBContext): TenantsDataAdapter {
  return {
    async create(params: CreateTenantParams): Promise<Tenant> {
      const now = new Date().toISOString();
      const id = params.id || nanoid();

      const item: TenantItem = {
        PK: tenantKeys.pk(id),
        SK: tenantKeys.sk(),
        GSI1PK: tenantKeys.gsi1pk(),
        GSI1SK: tenantKeys.gsi1sk(id),
        entityType: "TENANT",
        id,
        audience: params.audience,
        friendly_name: params.friendly_name,
        sender_name: params.sender_name,
        sender_email: params.sender_email,
        session_lifetime: params.session_lifetime,
        idle_session_lifetime: params.idle_session_lifetime,
        parent_tenant_id: params.parent_tenant_id,
        config_sync: params.config_sync,
        created_at: now,
        updated_at: now,
      };

      await putItem(ctx, item);

      return toTenant(item);
    },

    async get(id: string): Promise<Tenant | null> {
      const item = await getItem<TenantItem>(
        ctx,
        tenantKeys.pk(id),
        tenantKeys.sk(),
      );

      if (!item) return null;

      return toTenant(item);
    },

    async list(params = {}): Promise<{
      tenants: Tenant[];
      totals?: Totals;
    }> {
      const { include_totals = false, q } = params;

      // Free-text `q` matches the slug (id) and friendly_name,
      // case-insensitively and on partial matches. A single
      // `parent_tenant_id:<id>` clause selects the children of a tenant
      // exactly. DynamoDB can't filter either server-side, and tenants are few,
      // so filter in memory (offset mode only).
      if (q && !isKeysetRequest(params)) {
        const needle = q.toLowerCase();
        const tokens = tokenizeLuceneQuery(q);
        const parentId =
          tokens.length === 1 && tokens[0]!.startsWith("parent_tenant_id:")
            ? unquoteLuceneValue(tokens[0]!.slice("parent_tenant_id:".length))
            : undefined;
        const all = await queryWithPagination<TenantItem>(
          ctx,
          tenantKeys.gsi1pk(),
          { page: 0, per_page: 100000 },
          { indexName: "GSI1", skPrefix: "TENANT#" },
        );
        const matches = all.items
          .map(toTenant)
          .filter((t) =>
            parentId !== undefined
              ? t.parent_tenant_id === parentId
              : t.id.toLowerCase().includes(needle) ||
                (t.friendly_name ?? "").toLowerCase().includes(needle),
          );
        const { page = 0, per_page = 50 } = params;
        const tenants = matches.slice(page * per_page, (page + 1) * per_page);

        if (include_totals) {
          return {
            tenants,
            totals: {
              start: page * per_page,
              limit: per_page,
              length: matches.length,
            },
          };
        }
        return { tenants };
      }

      // Query all tenants using GSI1 where all tenants share GSI1PK="TENANTS"
      const result = await queryWithPagination<TenantItem>(
        ctx,
        tenantKeys.gsi1pk(),
        params,
        {
          indexName: "GSI1",
          skPrefix: "TENANT#",
        },
      );

      const tenants = result.items.map(toTenant);

      // Checkpoint mode carries the cursor in totals even without
      // include_totals — it is the only channel for `next`, and Auth0's
      // checkpoint responses have no total to report anyway.
      if (isKeysetRequest(params)) {
        return {
          tenants,
          totals: {
            start: result.start,
            limit: result.limit,
            length: result.length,
            next: result.next,
          },
        };
      }

      if (include_totals) {
        return {
          tenants,
          totals: {
            start: result.start,
            limit: result.limit,
            length: result.length,
          },
        };
      }

      return { tenants };
    },

    async update(id: string, tenant: Partial<Tenant>): Promise<void> {
      const updates = {
        ...tenant,
        updated_at: new Date().toISOString(),
      };

      await updateItem(ctx, tenantKeys.pk(id), tenantKeys.sk(), updates);
    },

    async remove(id: string): Promise<boolean> {
      return deleteItem(ctx, tenantKeys.pk(id), tenantKeys.sk());
    },
  };
}
