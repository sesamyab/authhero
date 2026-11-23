import { Kysely } from "kysely";
import {
  ListClientRegistrationTokensParams,
  ListClientRegistrationTokensResponse,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { rowToToken } from "./row-mapper";

export function list(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    params: ListClientRegistrationTokensParams = {},
  ): Promise<ListClientRegistrationTokensResponse> => {
    const page = params.page ?? 0;
    const per_page = params.per_page ?? 50;

    let query = db
      .selectFrom("client_registration_tokens")
      .where("tenant_id", "=", tenant_id);
    if (params.type) {
      query = query.where("type", "=", params.type);
    }
    if (params.client_id) {
      query = query.where("client_id", "=", params.client_id);
    }
    if (params.source) {
      query = query.where("source", "=", params.source);
    }

    const rows = await query
      .orderBy("created_at_ts", "desc")
      .limit(per_page)
      .offset(page * per_page)
      .selectAll()
      .execute();
    const tokens = rows.map(rowToToken);

    const base = {
      client_registration_tokens: tokens,
      start: page * per_page,
      limit: per_page,
      length: tokens.length,
    };
    if (!params.include_totals) {
      return base;
    }

    const totals = await query
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    return { ...base, total: Number(totals?.count ?? tokens.length) };
  };
}
