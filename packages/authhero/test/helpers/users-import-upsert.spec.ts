import { describe, it, expect } from "vitest";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import { advanceUsersImport } from "../../src/helpers/users-import/process";
import { deriveImportUserId } from "../../src/helpers/users-import/map";

/**
 * Pins how a row that matches an existing user is resolved.
 *
 * A row whose id equals the matched user's id is only that row's own earlier
 * write when the id was derived from (operation_id, seq). An explicit user_id
 * maps to the same id as a pre-existing user's, so under upsert it must fall
 * through to the update instead of being reported as a prior insert.
 */

// A real bcrypt hash: the import rejects anything else.
const HASH_A = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
const HASH_B = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.3Z8q1b1m5p1h6V8mK1Y9u0b3k6Qe";

type StoredUser = Record<string, unknown> & { user_id: string };

interface Setup {
  upsert: boolean;
  entry: Record<string, unknown>;
  existing?: StoredUser[];
  /** user_ids that already have a stored password. */
  passwords?: string[];
}

async function run({ upsert, entry, existing = [], passwords = [] }: Setup) {
  const users = new Map(existing.map((u) => [u.user_id, { ...u }]));
  const passwordRows = new Map<string, unknown>(
    passwords.map((id) => [id, { user_id: id, password: "existing" }]),
  );
  const createdPasswords: unknown[] = [];
  let outcomes: Record<string, unknown>[] = [];
  let claimed = false;

  const data = {
    tenantOperations: {
      get: async () => ({
        id: "op_1",
        tenant_id: "tenantId",
        kind: "users_import",
        status: "pending",
        input: {
          connection_id: "con_1",
          connection: "Username-Password-Authentication",
          provider: "auth0",
          upsert,
        },
        created_at: new Date().toISOString(),
      }),
      claim: async () => true,
      release: async () => true,
      update: async () => true,
      listResumable: async () => [],
    },
    tenantOperationRows: {
      countByStatus: async () => ({
        pending: claimed ? 0 : 1,
        inserted: 0,
        updated: 0,
        failed: 0,
        total: 1,
      }),
      claimPending: async () => {
        if (claimed) return [];
        claimed = true;
        return [
          {
            operation_id: "op_1",
            seq: 0,
            payload: entry,
            status: "pending" as const,
          },
        ];
      },
      recordOutcomes: async (_id: string, rows: Record<string, unknown>[]) => {
        outcomes = rows;
        return rows.length;
      },
    },
    users: {
      get: async (_t: string, id: string) => users.get(id) ?? null,
      // Identity probes by email/username/phone: `field:"value"`, possibly
      // OR-joined by the batched path.
      list: async (_t: string, params: { q?: string }) => {
        const wanted = [
          ...(params.q ?? "").matchAll(/(\w+):"((?:\\.|[^"])*)"/g),
        ];
        const found = [...users.values()].filter((u) =>
          wanted.some(([, field, value]) => u[field] === value),
        );
        return { users: found };
      },
      rawCreate: async (_t: string, user: StoredUser) => {
        users.set(user.user_id, user);
        return user;
      },
      createMany: async (_t: string, list: StoredUser[]) => {
        for (const u of list) users.set(u.user_id, u);
        return list;
      },
      update: async (
        _t: string,
        id: string,
        patch: Record<string, unknown>,
      ) => {
        users.set(id, { ...users.get(id)!, ...patch });
        return true;
      },
    },
    passwords: {
      get: async (_t: string, id: string) => passwordRows.get(id) ?? null,
      create: async (_t: string, p: { user_id: string }) => {
        createdPasswords.push(p);
        passwordRows.set(p.user_id, p);
        return p;
      },
    },
  } as unknown as DataAdapters;

  await advanceUsersImport(data, "op_1");
  return { outcome: outcomes[0], users, createdPasswords };
}

const existingUser: StoredUser = {
  user_id: "auth0|abc",
  email: "a@example.com",
  connection: "Username-Password-Authentication",
  given_name: "Old",
  user_metadata: { plan: "free" },
};

describe("users import — rows matching an existing user", () => {
  it("upsert + explicit user_id that exists updates the user", async () => {
    const { outcome, users } = await run({
      upsert: true,
      existing: [existingUser],
      entry: {
        user_id: "abc",
        email: "a@example.com",
        given_name: "New",
        user_metadata: { plan: "pro" },
      },
    });

    expect(outcome).toMatchObject({
      status: "updated",
      entity_id: "auth0|abc",
    });
    const stored = users.get("auth0|abc");
    expect(stored?.given_name).toBe("New");
    expect(stored?.user_metadata).toEqual({ plan: "pro" });
  });

  it("upsert leaves an existing password alone", async () => {
    const { outcome, createdPasswords } = await run({
      upsert: true,
      existing: [existingUser],
      passwords: ["auth0|abc"],
      entry: { user_id: "abc", email: "a@example.com", password_hash: HASH_B },
    });

    expect(outcome).toMatchObject({ status: "updated" });
    expect(createdPasswords).toHaveLength(0);
  });

  it("upsert creates the password when the user has none", async () => {
    const { outcome, createdPasswords } = await run({
      upsert: true,
      existing: [existingUser],
      entry: { user_id: "abc", email: "a@example.com", password_hash: HASH_A },
    });

    expect(outcome).toMatchObject({ status: "updated" });
    expect(createdPasswords).toEqual([
      expect.objectContaining({
        user_id: "auth0|abc",
        is_current: true,
        algorithm: "bcrypt",
      }),
    ]);
  });

  it("non-upsert + explicit user_id that exists fails as a duplicate", async () => {
    // The id match cannot be told apart from a pre-existing user, so it is a
    // conflict, as in Auth0. The existing user is left untouched.
    const { outcome, users } = await run({
      upsert: false,
      existing: [existingUser],
      entry: { user_id: "abc", email: "a@example.com", given_name: "New" },
    });

    expect(outcome).toMatchObject({
      status: "failed",
      error_code: "USER_ALREADY_EXISTS",
    });
    expect(users.get("auth0|abc")?.given_name).toBe("Old");
  });

  it("a retried derived-id row is still reported as inserted, not a conflict", async () => {
    const derived = `auth0|${await deriveImportUserId("op_1", 0)}`;
    const { outcome, createdPasswords } = await run({
      upsert: false,
      existing: [
        { ...existingUser, user_id: derived, email: "retry@example.com" },
      ],
      entry: { email: "retry@example.com", password_hash: HASH_A },
    });

    expect(outcome).toMatchObject({ status: "inserted", entity_id: derived });
    expect(outcome?.error_code).toBeUndefined();
    // The interrupted attempt's missing password is finished off.
    expect(createdPasswords).toHaveLength(1);
  });

  it("a retried derived-id row under upsert is also still inserted", async () => {
    const derived = `auth0|${await deriveImportUserId("op_1", 0)}`;
    const { outcome } = await run({
      upsert: true,
      existing: [
        { ...existingUser, user_id: derived, email: "retry@example.com" },
      ],
      entry: { email: "retry@example.com" },
    });

    expect(outcome).toMatchObject({ status: "inserted", entity_id: derived });
  });
});
