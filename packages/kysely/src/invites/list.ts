import { Kysely, Selectable } from "kysely";
import { Database } from "../db";
import {
  Invite,
  ListInvitesResponse,
  ListParams,
} from "@authhero/adapter-interfaces";
import { removeNullProperties } from "../helpers/remove-nulls";
import { parseJsonProperties } from "../helpers/parse";
import { luceneFilter } from "../helpers/filter";
import { isKeysetRequest, keysetPaginate } from "../helpers/paginate";

function toInvite(result: Selectable<Database["invites"]>) {
  const parsed = parseJsonProperties(result, {
    inviter: {},
    invitee: {},
    app_metadata: {},
    user_metadata: {},
    roles: [],
  });

  return removeNullProperties<Invite>({
    ...parsed,
    send_invitation_email: result.send_invitation_email === 1,
  });
}

export function list(db: Kysely<Database>) {
  return async (
    tenantId: string,
    params?: ListParams,
  ): Promise<ListInvitesResponse> => {
    // Keyset (checkpoint) pagination: from/take, newest first with the invite
    // id as tiebreaker. `q` (e.g. organization_id:<id>) stays in effect.
    if (isKeysetRequest(params)) {
      let keysetQuery = db
        .selectFrom("invites")
        .where("invites.tenant_id", "=", tenantId);
      if (params?.q) {
        keysetQuery = luceneFilter(db, keysetQuery, params.q, [
          "invitee",
          "inviter",
        ]);
      }
      const { rows, limit, next } = await keysetPaginate(
        keysetQuery.selectAll(),
        params,
        { sortColumn: "created_at", sortOrder: "desc", idColumn: "id" },
      );
      const keysetInvites = rows.map(toInvite);
      return {
        invites: keysetInvites,
        start: 0,
        limit,
        length: keysetInvites.length,
        next,
      };
    }

    let query = db
      .selectFrom("invites")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .orderBy("created_at", "desc");

    if (params?.per_page) {
      query = query.limit(params.per_page);
    }

    if (params?.page) {
      const offset = (params.page - 1) * (params.per_page || 10);
      query = query.offset(offset);
    }

    const results = await query.execute();

    const invites = results.map(toInvite);

    return {
      invites,
      start: params?.page ? (params.page - 1) * (params.per_page || 10) : 0,
      limit: params?.per_page || invites.length,
      length: invites.length,
    };
  };
}
