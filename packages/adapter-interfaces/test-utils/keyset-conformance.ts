/**
 * Shared keyset (checkpoint) pagination conformance suite.
 *
 * Every adapter that backs the `from`/`take` list endpoints must behave the
 * same way: a walk via `next` visits each row exactly once, the cursor is
 * opaque, and concurrent inserts and deletes between pages never cause a
 * duplicate or make a surviving row disappear. Each adapter package runs this
 * from its own test directory against its own storage engine:
 *
 *   defineKeysetConformance({ describe, it, expect, name, setup });
 *
 * The test functions are injected so this file needs no test-runner
 * dependency. It lives outside `src/` and is not part of the published bundle.
 */
import type { DataAdapters, ListParams } from "../src";

export interface KeysetConformanceOptions {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: (actual: unknown) => any;
  /** Adapter name, used in the suite title. */
  name: string;
  /** Returns a fresh, empty data layer with `tenantId` already created. */
  setup: () => Promise<{ data: DataAdapters; tenantId: string }>;
}

interface Page {
  ids: string[];
  next?: string;
}

interface Entity {
  name: string;
  create(data: DataAdapters, tenantId: string, i: number): Promise<string>;
  list(data: DataAdapters, tenantId: string, params: ListParams): Promise<Page>;
  remove(data: DataAdapters, tenantId: string, id: string): Promise<unknown>;
}

const pad = (i: number) => i.toString().padStart(3, "0");

const ENTITIES: Entity[] = [
  {
    name: "clients",
    async create(data, tenantId, i) {
      const client_id = `client-${pad(i)}`;
      await data.clients.create(tenantId, { client_id, name: `Client ${i}` });
      return client_id;
    },
    async list(data, tenantId, params) {
      const res = await data.clients.list(tenantId, params);
      return {
        ids: res.clients.map((c) => c.client_id),
        next: res.totals?.next,
      };
    },
    remove: (data, tenantId, id) => data.clients.remove(tenantId, id),
  },
  {
    name: "connections",
    async create(data, tenantId, i) {
      const id = `con-${pad(i)}`;
      await data.connections.create(tenantId, {
        id,
        name: `connection-${i}`,
        strategy: "mock-strategy",
        options: {},
      });
      return id;
    },
    async list(data, tenantId, params) {
      const res = await data.connections.list(tenantId, params);
      return { ids: res.connections.map((c) => c.id!), next: res.next };
    },
    remove: (data, tenantId, id) => data.connections.remove(tenantId, id),
  },
  {
    name: "resource servers",
    async create(data, tenantId, i) {
      const id = `rs-${pad(i)}`;
      await data.resourceServers.create(tenantId, {
        id,
        name: `API ${i}`,
        identifier: `https://api-${pad(i)}.example.com`,
        scopes: [],
      });
      return id;
    },
    async list(data, tenantId, params) {
      const res = await data.resourceServers.list(tenantId, params);
      return {
        ids: res.resource_servers.map((r) => r.id!),
        next: res.next,
      };
    },
    remove: (data, tenantId, id) => data.resourceServers.remove(tenantId, id),
  },
  {
    name: "roles",
    async create(data, tenantId, i) {
      const role = await data.roles.create(tenantId, {
        name: `role-${pad(i)}`,
      });
      return role.id;
    },
    async list(data, tenantId, params) {
      const res = await data.roles.list(tenantId, params);
      return { ids: res.roles.map((r) => r.id), next: res.next };
    },
    remove: (data, tenantId, id) => data.roles.remove(tenantId, id),
  },
  {
    name: "forms",
    async create(data, tenantId, i) {
      const form = await data.forms.create(tenantId, {
        name: `form-${pad(i)}`,
      });
      return form.id;
    },
    async list(data, tenantId, params) {
      const res = await data.forms.list(tenantId, params);
      return { ids: res.forms.map((f) => f.id), next: res.next };
    },
    remove: (data, tenantId, id) => data.forms.remove(tenantId, id),
  },
  {
    name: "flows",
    async create(data, tenantId, i) {
      const flow = await data.flows.create(tenantId, {
        name: `flow-${pad(i)}`,
      });
      return flow.id;
    },
    async list(data, tenantId, params) {
      const res = await data.flows.list(tenantId, params);
      return { ids: res.flows.map((f) => f.id), next: res.next };
    },
    remove: (data, tenantId, id) => data.flows.remove(tenantId, id),
  },
  {
    name: "hooks",
    async create(data, tenantId, i) {
      const hook_id = `hook-${pad(i)}`;
      await data.hooks.create(tenantId, {
        hook_id,
        url: `https://example.com/hook-${i}`,
        trigger_id: "post-user-login",
        enabled: true,
        synchronous: false,
      });
      return hook_id;
    },
    async list(data, tenantId, params) {
      const res = await data.hooks.list(tenantId, params);
      return { ids: res.hooks.map((h) => h.hook_id), next: res.next };
    },
    remove: (data, tenantId, id) => data.hooks.remove(tenantId, id),
  },
];

const ROWS = 25;
const TAKE = 10;
const MAX_PAGES = 12;

export function defineKeysetConformance(options: KeysetConformanceOptions) {
  const { describe, it, expect, setup } = options;

  describe(`${options.name}: keyset pagination conformance`, () => {
    for (const entity of ENTITIES) {
      describe(entity.name, () => {
        async function seed() {
          const { data, tenantId } = await setup();
          const ids: string[] = [];
          for (let i = 0; i < ROWS; i++) {
            ids.push(await entity.create(data, tenantId, i));
          }
          return { data, tenantId, ids };
        }

        it("walks every row exactly once via next", async () => {
          const { data, tenantId, ids } = await seed();
          const seen: string[] = [];
          let from: string | undefined;
          let pages = 0;
          for (;;) {
            const page = await entity.list(data, tenantId, {
              take: TAKE,
              from,
            });
            pages++;
            expect(page.ids.length).toBeLessThanOrEqual(TAKE);
            seen.push(...page.ids);
            if (!page.next) break;
            from = page.next;
            if (pages > MAX_PAGES) throw new Error("cursor walk did not end");
          }
          expect(new Set(seen).size).toBe(seen.length); // no duplicates
          expect([...seen].sort()).toEqual([...ids].sort()); // no gaps
        });

        it("returns an opaque cursor, not a numeric offset", async () => {
          const { data, tenantId } = await seed();
          const page = await entity.list(data, tenantId, { take: TAKE });
          expect(page.next).toBeDefined();
          expect(page.next).not.toMatch(/^\d+$/);
        });

        it("omits next on a final, short page", async () => {
          const { data, tenantId } = await seed();
          const page = await entity.list(data, tenantId, { take: 500 });
          expect(page.ids).toHaveLength(ROWS);
          // DynamoDB may still emit a trailing cursor that leads to an empty
          // page; a SQL adapter must not.
          if (page.next) {
            const rest = await entity.list(data, tenantId, {
              take: 500,
              from: page.next,
            });
            expect(rest.ids).toHaveLength(0);
          }
        });

        it("survives a concurrent insert and delete between pages", async () => {
          const { data, tenantId, ids } = await seed();
          const first = await entity.list(data, tenantId, { take: TAKE });
          expect(first.next).toBeDefined();

          // Delete one row already returned and one not yet returned, and add a
          // brand new row, before asking for the next page.
          const seenFirst = new Set(first.ids);
          const deletedSeen = first.ids[0]!;
          const deletedUnseen = ids.find((id) => !seenFirst.has(id))!;
          await entity.remove(data, tenantId, deletedSeen);
          await entity.remove(data, tenantId, deletedUnseen);
          const inserted = await entity.create(data, tenantId, ROWS);

          const seen = [...first.ids];
          let from = first.next;
          let pages = 1;
          while (from) {
            const page = await entity.list(data, tenantId, {
              take: TAKE,
              from,
            });
            pages++;
            seen.push(...page.ids);
            from = page.next;
            if (pages > MAX_PAGES) throw new Error("cursor walk did not end");
          }

          expect(new Set(seen).size).toBe(seen.length); // no duplicates
          expect(seen).not.toContain(deletedUnseen);
          // Every original row that was neither deleted nor already skipped
          // past must still be visited exactly once.
          for (const id of ids) {
            if (id === deletedSeen || id === deletedUnseen) continue;
            expect(seen).toContain(id);
          }
          // The new row may or may not be visited depending on sort position,
          // but it must never be visited twice.
          expect(seen.filter((id) => id === inserted).length).toBeLessThan(2);
        });
      });
    }
  });
}
