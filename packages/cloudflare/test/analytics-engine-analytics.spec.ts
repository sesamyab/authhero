import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  AnalyticsQueryParams,
  AnalyticsResource,
} from "@authhero/adapter-interfaces";
import { createAnalyticsEngineAnalyticsAdapter } from "../src/analytics-engine-logs";
import { aggregateRow, StoredRow } from "./helpers/fake-analytics-engine";

const SQL_ENDPOINT =
  "https://api.cloudflare.com/client/v4/accounts/test-account/analytics_engine/sql";

let queries: string[] = [];
let storedRows: StoredRow[] = [];

const server = setupServer(
  http.post(SQL_ENDPOINT, async ({ request }) => {
    const query = await request.text();
    queries.push(query);
    return HttpResponse.json({
      success: true,
      data: [aggregateRow(query, storedRows, { time: "2026-08-25" })],
    });
  }),
);

function createAdapter() {
  return createAnalyticsEngineAnalyticsAdapter({
    accountId: "test-account",
    apiToken: "test-token",
    dataset: "auth_logs",
  });
}

function params(
  overrides: Partial<AnalyticsQueryParams> = {},
): AnalyticsQueryParams {
  return {
    from: "2026-08-25T00:00:00.000Z",
    to: "2026-08-26T00:00:00.000Z",
    interval: "day",
    tz: "UTC",
    filters: {},
    group_by: [],
    limit: 100,
    offset: 0,
    ...overrides,
  };
}

// Every resource whose metric is an event count (everything but active-users).
const EVENT_COUNT_RESOURCES: Array<[AnalyticsResource, string]> = [
  ["logins", "logins"],
  ["signups", "signups"],
  ["refresh-tokens", "refresh_tokens"],
  ["sessions", "sessions"],
  ["logouts", "logouts"],
  ["password-changes", "password_changes"],
  ["password-migrations", "password_migrations"],
  ["mfa", "mfa"],
  ["email-verifications", "email_verifications"],
  ["codes-sent", "codes_sent"],
];

describe("Analytics Engine Analytics Adapter", () => {
  beforeAll(() => server.listen());
  afterAll(() => server.close());
  afterEach(() => {
    queries = [];
    storedRows = [];
  });

  // #1637: `count()` counts stored rows. Once Analytics Engine samples a
  // dataset each row stands for `_sample_interval` events, so event counts
  // must sum the interval instead.
  it.each(EVENT_COUNT_RESOURCES)(
    "weights the %s metric by _sample_interval",
    async (resource, alias) => {
      await createAdapter().query("tenant-1", resource, params());

      expect(queries[0]).toContain(`SUM(_sample_interval) AS "${alias}"`);
      expect(queries[0]).not.toContain("count()");
    },
  );

  it("returns event counts, not stored-row counts, for a sampled dataset", async () => {
    storedRows = [
      { blob3: "s", _sample_interval: 20 },
      { blob3: "f", _sample_interval: 20 },
      { blob3: "s", _sample_interval: 7 },
    ];

    const result = await createAdapter().query(
      "tenant-1",
      "logins",
      params({ group_by: ["time"] }),
    );

    expect(result.data).toEqual([{ time: "2026-08-25", logins: 47 }]);
  });

  it("matches a plain row count when the dataset is not sampled", async () => {
    storedRows = [
      { blob3: "ss", _sample_interval: 1 },
      { blob3: "ss", _sample_interval: 1 },
    ];

    const result = await createAdapter().query("tenant-1", "signups", params());

    expect(result.data[0]).toMatchObject({ signups: 2 });
  });

  // Distinct users can't be corrected by weighting; the metric is documented
  // as approximate (a lower bound) under sampling and stays COUNT(DISTINCT).
  it("keeps active-users as an unweighted distinct count", async () => {
    storedRows = [
      { blob3: "s", blob7: "user-1", _sample_interval: 10 },
      { blob3: "s", blob7: "user-1", _sample_interval: 10 },
      { blob3: "seacft", blob7: "user-2", _sample_interval: 10 },
    ];

    const result = await createAdapter().query(
      "tenant-1",
      "active-users",
      params(),
    );

    expect(queries[0]).toContain(`count(DISTINCT blob7) AS "active_users"`);
    expect(queries[0]).not.toContain("_sample_interval");
    expect(result.data[0]).toMatchObject({ active_users: 2 });
  });
});
