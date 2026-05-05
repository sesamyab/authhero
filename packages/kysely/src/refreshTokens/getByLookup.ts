import { RefreshToken } from "@authhero/adapter-interfaces";
import { Kysely } from "kysely";
import { Database } from "../db";
import { convertDatesToAdapter } from "../utils/dateConversion";

export function getByLookup(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    token_lookup: string,
  ): Promise<RefreshToken | null> => {
    const refreshToken = await db
      .selectFrom("refresh_tokens")
      .where("refresh_tokens.tenant_id", "=", tenant_id)
      .where("refresh_tokens.token_lookup", "=", token_lookup)
      .selectAll()
      .executeTakeFirst();

    if (!refreshToken) {
      return null;
    }

    const {
      tenant_id: _,
      created_at_ts,
      expires_at_ts,
      idle_expires_at_ts,
      last_exchanged_at_ts,
      revoked_at_ts,
      rotated_at_ts,
      ...rest
    } = refreshToken;

    const dates = convertDatesToAdapter(
      {
        created_at_ts,
        expires_at_ts,
        idle_expires_at_ts,
        last_exchanged_at_ts,
        revoked_at_ts,
        rotated_at_ts,
      },
      ["created_at_ts"],
      [
        "expires_at_ts",
        "idle_expires_at_ts",
        "last_exchanged_at_ts",
        "revoked_at_ts",
        "rotated_at_ts",
      ],
    ) as {
      created_at: string;
      expires_at?: string;
      idle_expires_at?: string;
      last_exchanged_at?: string;
      revoked_at?: string;
      rotated_at?: string;
    };

    return {
      ...rest,
      ...dates,
      rotating: !!refreshToken.rotating,
      device: refreshToken.device ? JSON.parse(refreshToken.device) : {},
      resource_servers: refreshToken.resource_servers
        ? JSON.parse(refreshToken.resource_servers)
        : [],
    };
  };
}
