import { Kysely } from "kysely";
import { Database } from "../db";
import { Organization, Totals, ListParams } from "@authhero/adapter-interfaces";
import { isKeysetRequest, keysetPaginate } from "../helpers/paginate";

type MembershipRow = {
  id: string;
  name: string;
  display_name?: string | null;
  branding: string | null;
  metadata: string | null;
  enabled_connections: string | null;
  token_quota: string | null;
  created_at: string;
  updated_at: string;
  joined_at: string;
};

function toOrganization(result: MembershipRow): Organization {
  return {
    id: result.id,
    name: result.name,
    display_name: result.display_name,
    branding: result.branding ? JSON.parse(result.branding) : undefined,
    metadata: result.metadata ? JSON.parse(result.metadata) : {},
    enabled_connections: result.enabled_connections
      ? JSON.parse(result.enabled_connections)
      : [],
    token_quota: result.token_quota
      ? JSON.parse(result.token_quota)
      : undefined,
    created_at: result.created_at,
    updated_at: result.updated_at,
    // Add membership info
    joined_at: result.joined_at,
  } as Organization;
}

export function listUserOrganizations(db: Kysely<Database>) {
  return async (
    tenantId: string,
    userId: string,
    params?: ListParams,
  ): Promise<{ organizations: Organization[] } & Totals> => {
    const page = params?.page || 0;
    const per_page = params?.per_page || 50;
    const offset = page * per_page;

    // Join user_organizations with organizations to get full organization details
    let query = db
      .selectFrom("user_organizations")
      .innerJoin("organizations", (join) =>
        join
          .onRef("organizations.id", "=", "user_organizations.organization_id")
          .on("organizations.tenant_id", "=", tenantId),
      )
      .select([
        "organizations.id",
        "organizations.name",
        "organizations.display_name",
        "organizations.branding",
        "organizations.metadata",
        "organizations.enabled_connections",
        "organizations.token_quota",
        "organizations.created_at",
        "organizations.updated_at",
        "user_organizations.created_at as joined_at",
      ])
      .where("user_organizations.tenant_id", "=", tenantId)
      .where("user_organizations.user_id", "=", userId);

    // Keyset (checkpoint) pagination: from/take, newest membership first with
    // the membership id as tiebreaker. The joined query is wrapped so the sort
    // and id columns have bare, unambiguous names (organizations has its own
    // created_at/id), which keeps the WHERE portable to MySQL.
    if (isKeysetRequest(params)) {
      const memberships = query
        .select("user_organizations.id as membership_id")
        .as("m");
      const { rows, limit, next } = await keysetPaginate(
        db.selectFrom(memberships).selectAll(),
        params,
        {
          sortColumn: "joined_at",
          sortOrder: "desc",
          idColumn: "membership_id",
        },
      );
      const keysetOrganizations = rows.map((r) =>
        toOrganization(r as unknown as MembershipRow),
      );
      return {
        organizations: keysetOrganizations,
        start: 0,
        limit,
        length: keysetOrganizations.length,
        next,
      };
    }

    query = query.orderBy("user_organizations.created_at", "desc");

    if (per_page > 0) {
      query = query.limit(per_page).offset(offset);
    }

    const results = await query.execute();

    // Get total count
    const countResult = await db
      .selectFrom("user_organizations")
      .innerJoin("organizations", (join) =>
        join
          .onRef("organizations.id", "=", "user_organizations.organization_id")
          .on("organizations.tenant_id", "=", tenantId),
      )
      .select(db.fn.count("user_organizations.id").as("count"))
      .where("user_organizations.tenant_id", "=", tenantId)
      .where("user_organizations.user_id", "=", userId)
      .executeTakeFirst();

    const organizations: Organization[] = results.map(toOrganization);

    return {
      organizations,
      start: offset,
      limit: per_page,
      length: Number(countResult?.count || 0),
    };
  };
}
