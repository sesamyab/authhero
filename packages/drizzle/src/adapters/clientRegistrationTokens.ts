import { and, count, eq, isNull, desc, type SQL } from "drizzle-orm";
import {
  ClientRegistrationToken,
  ClientRegistrationTokenInsert,
  ClientRegistrationTokensAdapter,
  clientRegistrationTokenSourceSchema,
  clientRegistrationTokenTypeSchema,
  isPlainObject,
} from "@authhero/adapter-interfaces";
import { clientRegistrationTokens } from "../schema/sqlite/clients";
import type { DrizzleDb } from "./types";

type Row = typeof clientRegistrationTokens.$inferSelect;

function parseConstraints(
  raw: string | null,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  return isPlainObject(parsed) ? parsed : undefined;
}

function tsToIso(ts: number | null): string | undefined {
  return ts == null ? undefined : new Date(ts).toISOString();
}

function isoToTs(iso: string | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function parseSource(raw: string | null) {
  const parsed = clientRegistrationTokenSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function rowToToken(row: Row): ClientRegistrationToken {
  const type = clientRegistrationTokenTypeSchema.parse(row.type);
  return {
    id: row.id,
    token_hash: row.token_hash,
    type,
    client_id: row.client_id ?? undefined,
    sub: row.sub ?? undefined,
    constraints: parseConstraints(row.constraints),
    single_use: !!row.single_use,
    expires_at: tsToIso(row.expires_at_ts),
    used_at: tsToIso(row.used_at_ts),
    revoked_at: tsToIso(row.revoked_at_ts),
    created_at: new Date(row.created_at_ts).toISOString(),
    name: row.name ?? undefined,
    created_by: row.created_by ?? undefined,
    source: parseSource(row.source),
  };
}

export function createClientRegistrationTokensAdapter(
  db: DrizzleDb,
): ClientRegistrationTokensAdapter {
  return {
    async create(
      tenant_id: string,
      params: ClientRegistrationTokenInsert,
    ): Promise<ClientRegistrationToken> {
      const now = Date.now();
      await db.insert(clientRegistrationTokens).values({
        id: params.id,
        tenant_id,
        token_hash: params.token_hash,
        type: params.type,
        client_id: params.client_id ?? null,
        sub: params.sub ?? null,
        constraints: params.constraints
          ? JSON.stringify(params.constraints)
          : null,
        single_use: params.single_use ? 1 : 0,
        expires_at_ts: isoToTs(params.expires_at),
        created_at_ts: now,
        name: params.name ?? null,
        created_by: params.created_by ?? null,
        source: params.source ?? null,
      });

      return {
        id: params.id,
        token_hash: params.token_hash,
        type: params.type,
        client_id: params.client_id,
        sub: params.sub,
        constraints: params.constraints,
        single_use: params.single_use,
        expires_at: params.expires_at,
        created_at: new Date(now).toISOString(),
        name: params.name,
        created_by: params.created_by,
        source: params.source,
      };
    },

    async get(tenant_id, id) {
      const row = await db
        .select()
        .from(clientRegistrationTokens)
        .where(
          and(
            eq(clientRegistrationTokens.tenant_id, tenant_id),
            eq(clientRegistrationTokens.id, id),
          ),
        )
        .get();
      return row ? rowToToken(row) : null;
    },

    async getByHash(tenant_id, token_hash) {
      const row = await db
        .select()
        .from(clientRegistrationTokens)
        .where(
          and(
            eq(clientRegistrationTokens.tenant_id, tenant_id),
            eq(clientRegistrationTokens.token_hash, token_hash),
          ),
        )
        .get();
      return row ? rowToToken(row) : null;
    },

    async list(tenant_id, params = {}) {
      const page = params.page ?? 0;
      const per_page = params.per_page ?? 50;
      const filters: SQL[] = [
        eq(clientRegistrationTokens.tenant_id, tenant_id),
      ];
      if (params.type) {
        filters.push(eq(clientRegistrationTokens.type, params.type));
      }
      if (params.client_id) {
        filters.push(eq(clientRegistrationTokens.client_id, params.client_id));
      }
      if (params.source) {
        filters.push(eq(clientRegistrationTokens.source, params.source));
      }
      const where = and(...filters);

      const rows = await db
        .select()
        .from(clientRegistrationTokens)
        .where(where)
        .orderBy(desc(clientRegistrationTokens.created_at_ts))
        .limit(per_page)
        .offset(page * per_page);
      const tokens = rows.map(rowToToken);

      if (!params.include_totals) {
        return {
          client_registration_tokens: tokens,
          start: page * per_page,
          limit: per_page,
          length: tokens.length,
        };
      }

      const [totals] = await db
        .select({ total: count() })
        .from(clientRegistrationTokens)
        .where(where);
      return {
        client_registration_tokens: tokens,
        start: page * per_page,
        limit: per_page,
        length: tokens.length,
        total: totals?.total ?? tokens.length,
      };
    },

    async listByClient(tenant_id, client_id) {
      const rows = await db
        .select()
        .from(clientRegistrationTokens)
        .where(
          and(
            eq(clientRegistrationTokens.tenant_id, tenant_id),
            eq(clientRegistrationTokens.client_id, client_id),
          ),
        )
        .orderBy(desc(clientRegistrationTokens.created_at_ts));
      return rows.map(rowToToken);
    },

    async markUsed(tenant_id, id, used_at, client_id) {
      const result = await db
        .update(clientRegistrationTokens)
        .set({
          used_at_ts: isoToTs(used_at),
          ...(client_id ? { client_id } : {}),
        })
        .where(
          and(
            eq(clientRegistrationTokens.tenant_id, tenant_id),
            eq(clientRegistrationTokens.id, id),
            isNull(clientRegistrationTokens.used_at_ts),
          ),
        )
        .returning();
      return result.length > 0;
    },

    async revoke(tenant_id, id, revoked_at) {
      const result = await db
        .update(clientRegistrationTokens)
        .set({ revoked_at_ts: isoToTs(revoked_at) })
        .where(
          and(
            eq(clientRegistrationTokens.tenant_id, tenant_id),
            eq(clientRegistrationTokens.id, id),
            isNull(clientRegistrationTokens.revoked_at_ts),
          ),
        )
        .returning();
      return result.length > 0;
    },

    async revokeByClient(tenant_id, client_id, revoked_at) {
      const result = await db
        .update(clientRegistrationTokens)
        .set({ revoked_at_ts: isoToTs(revoked_at) })
        .where(
          and(
            eq(clientRegistrationTokens.tenant_id, tenant_id),
            eq(clientRegistrationTokens.client_id, client_id),
            isNull(clientRegistrationTokens.revoked_at_ts),
          ),
        )
        .returning();
      return result.length;
    },

    async remove(tenant_id, id) {
      const result = await db
        .delete(clientRegistrationTokens)
        .where(
          and(
            eq(clientRegistrationTokens.tenant_id, tenant_id),
            eq(clientRegistrationTokens.id, id),
          ),
        )
        .returning();
      return result.length > 0;
    },
  };
}
