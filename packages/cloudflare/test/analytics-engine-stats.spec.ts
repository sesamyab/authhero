import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { createAnalyticsEngineStatsAdapter } from "../src/analytics-engine-logs";
import createAdapters from "../src/index";
import { aggregateRow, StoredRow } from "./helpers/fake-analytics-engine";

const SQL_ENDPOINT =
  "https://api.cloudflare.com/client/v4/accounts/test-account/analytics_engine/sql";

// Queries the adapter sent, in order. Assertions read the SQL text directly:
// the whole point of these tests is that the interpolated bounds are real
// epoch milliseconds and not `NaN`.
let queries: string[] = [];
let rows: Record<string, unknown>[] = [];
// When set, the fake evaluates the query's aggregates over these stored rows
// (each with its `_sample_interval`) instead of returning `rows` verbatim.
let storedRows: StoredRow[] | undefined;

const server = setupServer(
  http.post(SQL_ENDPOINT, async ({ request }) => {
    const query = await request.text();
    queries.push(query);
    const data = storedRows
      ? [aggregateRow(query, storedRows, { date: "2026-08-25" })]
      : rows;
    return HttpResponse.json({ success: true, data });
  }),
);

function createAdapter() {
  return createAnalyticsEngineStatsAdapter({
    accountId: "test-account",
    apiToken: "test-token",
    dataset: "auth_logs",
  });
}

/** Pull the `double2 >= X` / `double2 <= Y` bounds out of the generated SQL. */
function timestampBounds(query: string): { from?: string; to?: string } {
  return {
    from: query.match(/double2 >= (\S+)/)?.[1],
    to: query.match(/double2 <= (\S+)/)?.[1],
  };
}

describe("Analytics Engine Stats Adapter", () => {
  beforeAll(() => server.listen());
  afterAll(() => server.close());
  afterEach(() => {
    queries = [];
    rows = [];
    storedRows = undefined;
  });

  describe("getDaily", () => {
    // The management API normalizes `from`/`to` to YYYY-MM-DD before calling
    // the adapter. Re-slicing those as YYYYMMDD produced "2026--0-7-", so both
    // bounds became NaN and every query returned nothing — the dashboard
    // rendered 30 days of zeros.
    it("accepts already-normalized YYYY-MM-DD dates", async () => {
      await createAdapter().getDaily("tenant-1", {
        from: "2026-07-27",
        to: "2026-08-26",
      });

      const bounds = timestampBounds(queries[0]!);
      expect(bounds.from).toBe(String(Date.UTC(2026, 6, 27, 0, 0, 0, 0)));
      expect(bounds.to).toBe(String(Date.UTC(2026, 7, 26, 23, 59, 59, 999)));
      expect(queries[0]).not.toContain("NaN");
    });

    it("still accepts the Auth0-style YYYYMMDD dates", async () => {
      await createAdapter().getDaily("tenant-1", {
        from: "20260727",
        to: "20260826",
      });

      const bounds = timestampBounds(queries[0]!);
      expect(bounds.from).toBe(String(Date.UTC(2026, 6, 27, 0, 0, 0, 0)));
      expect(bounds.to).toBe(String(Date.UTC(2026, 7, 26, 23, 59, 59, 999)));
    });

    it("defaults to the last 30 days with real bounds", async () => {
      await createAdapter().getDaily("tenant-1");

      const bounds = timestampBounds(queries[0]!);
      expect(Number(bounds.from)).not.toBeNaN();
      expect(Number(bounds.to)).not.toBeNaN();
      expect(Number(bounds.to)).toBeGreaterThan(Number(bounds.from));
    });

    it("throws rather than querying with NaN bounds", async () => {
      await expect(
        createAdapter().getDaily("tenant-1", { from: "not-a-date" }),
      ).rejects.toThrow(/Invalid stats date range/);
      expect(queries).toHaveLength(0);
    });

    // `new Date("2026-02-30T00:00:00Z")` rolls over to March 2 instead of
    // failing, which would silently query a window the caller never asked for.
    it.each(["20260230", "2026-02-30", "20260431"])(
      "rejects the impossible calendar date %s",
      async (from) => {
        await expect(
          createAdapter().getDaily("tenant-1", { from }),
        ).rejects.toThrow(/Invalid stats date range/);
        expect(queries).toHaveLength(0);
      },
    );

    it("accepts a leap day in a leap year", async () => {
      await createAdapter().getDaily("tenant-1", {
        from: "20240229",
        to: "20240229",
      });

      expect(timestampBounds(queries[0]!).from).toBe(
        String(Date.UTC(2024, 1, 29, 0, 0, 0, 0)),
      );
    });

    it("scopes the query to the tenant and the configured dataset", async () => {
      await createAdapter().getDaily("tenant-1", {
        from: "2026-07-27",
        to: "2026-08-26",
      });

      expect(queries[0]).toContain(`FROM "auth_logs"`);
      expect(queries[0]).toContain(`index1 = 'tenant-1'`);
    });

    it("maps aggregated rows to DailyStats", async () => {
      rows = [
        {
          date: "2026-08-25",
          logins: "12",
          signups: "3",
          leaked_passwords: "1",
          first_event: 1787616000000,
          last_event: 1787702399000,
        },
      ];

      const stats = await createAdapter().getDaily("tenant-1", {
        from: "2026-08-25",
        to: "2026-08-25",
      });

      expect(stats).toEqual([
        {
          date: "2026-08-25",
          logins: 12,
          signups: 3,
          leaked_passwords: 1,
          created_at: new Date(1787616000000).toISOString(),
          updated_at: new Date(1787702399000).toISOString(),
        },
      ]);
    });

    it("counts only SUCCESS_LOGIN as logins and pwd_leak as leaked passwords", async () => {
      await createAdapter().getDaily("tenant-1", {
        from: "2026-08-25",
        to: "2026-08-25",
      });

      // Auth0 parity: token exchanges ('seacft') and silent auth ('ssa') must
      // not inflate the login count.
      expect(queries[0]).toContain(
        "SUM(CASE WHEN blob3 IN ('s') THEN _sample_interval ELSE 0 END) AS logins",
      );
      expect(queries[0]).toContain(
        "SUM(CASE WHEN blob3 = 'ss' THEN _sample_interval ELSE 0 END) AS signups",
      );
      expect(queries[0]).toContain(
        "SUM(CASE WHEN blob3 IN ('pwd_leak') THEN _sample_interval ELSE 0 END) AS leaked_passwords",
      );
    });

    // #1637: once Analytics Engine samples a dataset, each stored row stands
    // for `_sample_interval` events. Counting rows (`THEN 1`) under-counts by
    // that factor; the counts must be weighted.
    it("weights counts by _sample_interval when the dataset is sampled", async () => {
      storedRows = [
        { blob3: "s", _sample_interval: 10 },
        { blob3: "s", _sample_interval: 10 },
        { blob3: "s", _sample_interval: 5 },
        { blob3: "ss", _sample_interval: 10 },
        { blob3: "pwd_leak", _sample_interval: 4 },
        // Not a login for Auth0 parity, sampled or not.
        { blob3: "seacft", _sample_interval: 10 },
      ];

      const [day] = await createAdapter().getDaily("tenant-1", {
        from: "2026-08-25",
        to: "2026-08-25",
      });

      expect(day).toMatchObject({
        date: "2026-08-25",
        logins: 25,
        signups: 10,
        leaked_passwords: 4,
      });
      expect(queries[0]).not.toMatch(/THEN 1 ELSE 0/);
    });

    it("matches a plain row count when the dataset is not sampled", async () => {
      storedRows = [
        { blob3: "s", _sample_interval: 1 },
        { blob3: "s", _sample_interval: 1 },
        { blob3: "ss", _sample_interval: 1 },
      ];

      const [day] = await createAdapter().getDaily("tenant-1", {
        from: "2026-08-25",
        to: "2026-08-25",
      });

      expect(day).toMatchObject({ logins: 2, signups: 1, leaked_passwords: 0 });
    });
  });

  describe("getActiveUsers", () => {
    it("counts distinct logged-in users over the last 30 days", async () => {
      rows = [{ count: 42 }];

      const count = await createAdapter().getActiveUsers("tenant-1");

      expect(count).toBe(42);
      expect(queries[0]).toContain("COUNT(DISTINCT blob7) AS count");
      expect(queries[0]).toContain(`index1 = 'tenant-1'`);
      expect(queries[0]).toContain("blob3 IN ('s')");
      expect(timestampBounds(queries[0]!).from).not.toBe("NaN");
    });

    // A distinct count can't be weighted by _sample_interval: users whose
    // login rows were all dropped by the sampler are simply missing. The value
    // is documented as approximate (a lower bound) under sampling; this pins
    // that it is still a distinct count of stored users, not a weighted sum.
    it("stays an unweighted distinct count under sampling", async () => {
      storedRows = [
        { blob3: "s", blob7: "user-1", _sample_interval: 10 },
        { blob3: "s", blob7: "user-1", _sample_interval: 10 },
        { blob3: "s", blob7: "user-2", _sample_interval: 10 },
      ];

      expect(await createAdapter().getActiveUsers("tenant-1")).toBe(2);
      expect(queries[0]).not.toContain("_sample_interval");
    });

    it("returns 0 when the dataset has no matching rows", async () => {
      rows = [];
      expect(await createAdapter().getActiveUsers("tenant-1")).toBe(0);
    });
  });

  describe("createAdapters wiring", () => {
    // Without this, consumers that move logs to Analytics Engine keep the SQL
    // adapter's stats, which reads a logs table nothing writes to any more.
    it("exposes a stats adapter when Analytics Engine logs are configured", async () => {
      const adapters = createAdapters({
        zoneId: "zone",
        authKey: "key",
        authEmail: "email@example.com",
        analyticsEngineLogs: {
          accountId: "test-account",
          apiToken: "test-token",
          dataset: "auth_logs",
        },
      });

      expect(adapters.stats).toBeDefined();

      await adapters.stats!.getDaily("tenant-1", {
        from: "2026-07-27",
        to: "2026-08-26",
      });
      expect(queries[0]).toContain(`FROM "auth_logs"`);
      expect(queries[0]).not.toContain("NaN");
    });

    it("leaves stats undefined when Analytics Engine is not configured", () => {
      const adapters = createAdapters({
        zoneId: "zone",
        authKey: "key",
        authEmail: "email@example.com",
      });

      expect(adapters.stats).toBeUndefined();
    });
  });
});
