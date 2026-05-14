import { Kysely, sql, RawBuilder } from "kysely";
import {
  AnalyticsAdapter,
  AnalyticsGroupBy,
  AnalyticsQueryParams,
  AnalyticsQueryResponse,
  AnalyticsResource,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";

// Source events per resource (mirrors the CF AE adapter).
const RESOURCE_EVENTS: Record<AnalyticsResource, readonly string[]> = {
  "active-users": ["s", "seacft"],
  logins: ["s", "f", "fp"],
  signups: ["ss", "fs"],
  "refresh-tokens": ["seacft", "fertft"],
  sessions: ["slo"],
};

const METRIC_BY_RESOURCE: Record<
  AnalyticsResource,
  { alias: string; type: string; agg: "count" | "uniq" }
> = {
  "active-users": { alias: "active_users", type: "UInt64", agg: "uniq" },
  logins: { alias: "logins", type: "UInt64", agg: "count" },
  signups: { alias: "signups", type: "UInt64", agg: "count" },
  "refresh-tokens": {
    alias: "refresh_tokens",
    type: "UInt64",
    agg: "count",
  },
  sessions: { alias: "sessions", type: "UInt64", agg: "count" },
};

function timeBucketSql(interval: string): RawBuilder<string> {
  const date = sql.ref("logs.date");
  switch (interval) {
    case "hour":
      return sql<string>`substr(${date}, 1, 13)`;
    case "month":
      return sql<string>`substr(${date}, 1, 7)`;
    case "day":
      return sql<string>`substr(${date}, 1, 10)`;
    case "week":
      // ISO week start (Monday). SQLite's strftime("%w") returns 0=Sunday;
      // subtract (%w + 6) % 7 days to land on Monday. MySQL would need a
      // different expression — the SQL fallback targets SQLite.
      return sql<string>`date(substr(${date}, 1, 10), '-' || ((cast(strftime('%w', substr(${date}, 1, 10)) as integer) + 6) % 7) || ' days')`;
    default:
      throw new Error(
        `Unsupported interval '${interval}' for SQL analytics adapter`,
      );
  }
}

function dimensionColumn(dim: AnalyticsGroupBy): string {
  switch (dim) {
    case "connection":
      return "logs.connection";
    case "client_id":
      return "logs.client_id";
    case "user_type":
      return "logs.strategy_type";
    case "event":
      return "logs.type";
    case "time":
      throw new Error("time dimension is handled separately");
  }
}

export function createAnalyticsAdapter(
  db: Kysely<Database>,
): AnalyticsAdapter {
  return {
    async query(
      tenantId: string,
      resource: AnalyticsResource,
      params: AnalyticsQueryParams,
    ): Promise<AnalyticsQueryResponse> {
      const startedAt = Date.now();
      const events = RESOURCE_EVENTS[resource];
      const metric = METRIC_BY_RESOURCE[resource];

      const meta: AnalyticsQueryResponse["meta"] = [];
      let qb = db.selectFrom("logs").where("tenant_id", "=", tenantId);

      qb = qb.where("date", ">=", params.from).where("date", "<", params.to);
      // The Database.logs.type column is a tight union of known log types;
      // cast events through `never` to satisfy kysely's literal-typed `in`.
      qb = qb.where("type", "in", events as never);

      if (params.filters.connection?.length) {
        qb = qb.where("connection", "in", params.filters.connection);
      }
      if (params.filters.client_id?.length) {
        qb = qb.where("client_id", "in", params.filters.client_id);
      }
      if (params.filters.user_type?.length) {
        qb = qb.where(
          "strategy_type",
          "in",
          params.filters.user_type as unknown as string[],
        );
      }
      if (params.filters.user_id?.length) {
        qb = qb.where("user_id", "in", params.filters.user_id);
      }

      // Build SELECT and GROUP BY based on group_by dimensions.
      const groupRefs: Array<RawBuilder<string>> = [];
      const selectExprs: Array<{
        alias: string;
        expr: RawBuilder<unknown>;
      }> = [];

      for (const dim of params.group_by) {
        if (dim === "time") {
          const bucket = timeBucketSql(params.interval);
          selectExprs.push({ alias: "time", expr: bucket });
          groupRefs.push(bucket);
          meta.push({
            name: "time",
            type: params.interval === "hour" ? "DateTime" : "Date",
          });
        } else {
          const col = dimensionColumn(dim);
          selectExprs.push({ alias: dim, expr: sql<string>`${sql.ref(col)}` });
          groupRefs.push(sql<string>`${sql.ref(col)}`);
          meta.push({ name: dim, type: "String" });
        }
      }

      const metricExpr =
        metric.agg === "uniq"
          ? sql<number>`COUNT(DISTINCT ${sql.ref("logs.user_id")})`
          : sql<number>`COUNT(*)`;
      selectExprs.push({ alias: metric.alias, expr: metricExpr });
      meta.push({ name: metric.alias, type: metric.type });

      let selectQb = qb.select(
        selectExprs.map(({ alias, expr }) => expr.as(alias)) as never,
      );

      if (groupRefs.length > 0) {
        selectQb = selectQb.groupBy(groupRefs as never);
      }

      // ORDER BY
      if (params.order_by) {
        const desc = params.order_by.startsWith("-");
        const col = desc ? params.order_by.slice(1) : params.order_by;
        selectQb = selectQb.orderBy(col as never, desc ? "desc" : "asc");
      } else if (params.group_by.length > 0 && params.group_by[0] === "time") {
        selectQb = selectQb.orderBy("time" as never, "asc");
      } else {
        selectQb = selectQb.orderBy(metric.alias as never, "desc");
      }

      selectQb = selectQb.limit(params.limit).offset(params.offset);

      const rows = (await selectQb.execute()) as Array<
        Record<string, unknown>
      >;

      const data = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const m of meta) {
          const raw = row[m.name];
          out[m.name] =
            m.type === "UInt64"
              ? Number(raw) || 0
              : raw === null || raw === undefined
                ? ""
                : raw;
        }
        return out;
      });

      return {
        meta,
        data,
        rows: data.length,
        rows_before_limit_at_least: data.length,
        statistics: { elapsed: (Date.now() - startedAt) / 1000 },
      };
    },
  };
}
