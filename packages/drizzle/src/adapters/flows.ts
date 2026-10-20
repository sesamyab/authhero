import { eq, and, count as countFn, asc, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Flow, ListParams } from "@authhero/adapter-interfaces";
import { flows } from "../schema/sqlite";
import { removeNullProperties, parseJsonIfString } from "../helpers/transform";
import { buildLuceneFilter, sanitizeLuceneQuery } from "../helpers/filter";
import {
  isKeysetRequest,
  keysetCondition,
  keysetOrderBy,
  keysetTake,
  sliceWithNext,
} from "../helpers/paginate";
import type { DrizzleDb } from "./types";

// Fields flows.list() accepts in `q`. Excludes `tenant_id`.
const ALLOWED_Q_FIELDS = ["id", "name"];

function sqlToFlow(row: typeof flows.$inferSelect) {
  const { tenant_id: _, actions, ...rest } = row;
  return removeNullProperties({
    ...rest,
    actions: parseJsonIfString(actions, []),
  });
}

export function createFlowsAdapter(db: DrizzleDb) {
  return {
    async create(tenant_id: string, params: any): Promise<Flow> {
      const now = new Date().toISOString();
      const id = `af_${nanoid()}`;

      await db.insert(flows).values({
        id,
        tenant_id,
        name: params.name,
        actions: JSON.stringify(params.actions || []),
        created_at: now,
        updated_at: now,
      });

      return {
        id,
        name: params.name,
        actions: params.actions || [],
        created_at: now,
        updated_at: now,
      };
    },

    async get(tenant_id: string, flow_id: string): Promise<Flow | null> {
      const result = await db
        .select()
        .from(flows)
        .where(and(eq(flows.tenant_id, tenant_id), eq(flows.id, flow_id)))
        .get();

      if (!result) return null;

      const { tenant_id: _, actions, ...rest } = result;
      return removeNullProperties({
        ...rest,
        actions: parseJsonIfString(actions, []),
      });
    },

    async update(
      tenant_id: string,
      flow_id: string,
      params: Partial<Flow>,
    ): Promise<Flow | null> {
      const updateData: any = {
        updated_at: new Date().toISOString(),
      };

      if (params.name !== undefined) updateData.name = params.name;
      if (params.actions !== undefined)
        updateData.actions = JSON.stringify(params.actions);

      const results = await db
        .update(flows)
        .set(updateData)
        .where(and(eq(flows.tenant_id, tenant_id), eq(flows.id, flow_id)))
        .returning();

      if (results.length === 0) return null;

      // Fetch updated
      return this.get(tenant_id, flow_id);
    },

    async list(tenant_id: string, params?: ListParams) {
      const {
        page = 0,
        per_page = 50,
        include_totals = false,
        sort,
        q,
      } = params || {};

      const conditions = [eq(flows.tenant_id, tenant_id)];
      if (q) {
        // Sanitize first so only whitelisted fields reach buildLuceneFilter;
        // otherwise a clause like `q=tenant_id:other` would emit SQL against
        // arbitrary columns.
        const sanitized = sanitizeLuceneQuery(q, ALLOWED_Q_FIELDS);
        if (sanitized) {
          const filter = buildLuceneFilter(flows, sanitized, []);
          if (filter) conditions.push(filter);
        }
      }
      const whereClause = and(...conditions);

      // Keyset (checkpoint) pagination: from/take. Fixed created_at desc order
      // with an id tiebreaker and no total.
      if (isKeysetRequest(params)) {
        const cols = {
          sortColumn: flows.created_at,
          idColumn: flows.id,
          sortOrder: "desc" as const,
        };
        const take = keysetTake(params);
        const cond = keysetCondition(params, cols);
        const rows = await db
          .select()
          .from(flows)
          .where(cond ? and(whereClause, cond) : whereClause)
          .orderBy(...keysetOrderBy(cols))
          .limit(take + 1);
        const { rows: pageRows, next } = sliceWithNext(
          rows,
          take,
          "created_at",
          "id",
        );
        const keysetFlows = pageRows.map(sqlToFlow);
        return {
          flows: keysetFlows,
          start: 0,
          limit: take,
          length: keysetFlows.length,
          next,
        };
      }

      let query = db.select().from(flows).where(whereClause).$dynamic();

      if (sort?.sort_by) {
        const col = (flows as any)[sort.sort_by];
        if (col) {
          query = query.orderBy(
            sort.sort_order === "desc" ? desc(col) : asc(col),
          );
        }
      }

      const results = await query.offset(page * per_page).limit(per_page);
      const mapped = results.map(sqlToFlow);

      if (!include_totals) {
        return { flows: mapped };
      }

      const [countResult] = await db
        .select({ count: countFn() })
        .from(flows)
        .where(whereClause);

      return {
        flows: mapped,
        start: page * per_page,
        limit: per_page,
        length: Number(countResult?.count ?? 0),
      };
    },

    async remove(tenant_id: string, flow_id: string): Promise<boolean> {
      const results = await db
        .delete(flows)
        .where(and(eq(flows.tenant_id, tenant_id), eq(flows.id, flow_id)))
        .returning();

      return results.length > 0;
    },
  };
}
