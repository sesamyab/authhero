import {
  ListParams,
  ListSesssionsResponse,
} from "@authhero/adapter-interfaces";
import { Kysely, Selectable } from "kysely";
import { luceneFilter } from "../helpers/filter";
import { Database } from "../db";
import getCountAsInt from "../utils/getCountAsInt";
import { convertDatesToAdapter } from "../utils/dateConversion";
import { keysetPaginate, isKeysetRequest } from "../helpers/paginate";

function toSession(session: Selectable<Database["sessions"]>) {
  const {
    tenant_id: _,
    device,
    clients,
    created_at_ts,
    updated_at_ts,
    expires_at_ts,
    idle_expires_at_ts,
    authenticated_at_ts,
    last_interaction_at_ts,
    used_at_ts,
    revoked_at_ts,
    ...rest
  } = session;

  // Convert dates from DB format (bigint) to ISO strings
  const dates = convertDatesToAdapter(
    {
      created_at_ts,
      updated_at_ts,
      expires_at_ts,
      idle_expires_at_ts,
      authenticated_at_ts,
      last_interaction_at_ts,
      used_at_ts,
      revoked_at_ts,
    },
    [
      "created_at_ts",
      "updated_at_ts",
      "authenticated_at_ts",
      "last_interaction_at_ts",
    ],
    ["expires_at_ts", "idle_expires_at_ts", "used_at_ts", "revoked_at_ts"],
  ) as {
    created_at: string;
    updated_at: string;
    authenticated_at: string;
    last_interaction_at: string;
    expires_at?: string;
    idle_expires_at?: string;
    used_at?: string;
    revoked_at?: string;
  };

  return {
    ...rest,
    ...dates,
    device: JSON.parse(device),
    clients: JSON.parse(clients),
  };
}

export function list(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    params: ListParams = {},
  ): Promise<ListSesssionsResponse> => {
    const { page = 0, per_page = 50, include_totals = false, sort, q } = params;

    let query = db
      .selectFrom("sessions")
      .where("sessions.tenant_id", "=", tenant_id);

    if (q) {
      query = luceneFilter(db, query, q, ["user_id", "session_id"]);
    }

    // Keyset (checkpoint) pagination: from/take. Fixed created_at desc order
    // with an id tiebreaker and no total, matching /users/{id}/refresh-tokens.
    if (isKeysetRequest(params)) {
      const { rows, limit, next } = await keysetPaginate(
        query.selectAll(),
        params,
        { sortColumn: "created_at_ts", sortOrder: "desc" },
      );
      const keysetSessions = rows.map(toSession);
      return {
        sessions: keysetSessions,
        start: 0,
        limit,
        length: keysetSessions.length,
        next,
      };
    }

    let filteredQuery = query;

    if (sort && sort.sort_by) {
      const { ref } = db.dynamic;
      filteredQuery = filteredQuery.orderBy(ref(sort.sort_by), sort.sort_order);
    }

    filteredQuery = filteredQuery.offset(page * per_page).limit(per_page);

    const sessions = await filteredQuery.selectAll().execute();

    const mappedSessions = sessions.map(toSession);

    if (!include_totals) {
      return {
        sessions: mappedSessions,
        start: 0,
        limit: 0,
        length: 0,
      };
    }

    const { count } = await query
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirstOrThrow();

    const countInt = getCountAsInt(count);

    return {
      sessions: mappedSessions,
      start: page * per_page,
      limit: per_page,
      length: countInt,
    };
  };
}
