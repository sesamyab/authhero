import { Kysely } from "kysely";
import {
  Connection,
  ConnectionInsert,
  ConnectionInternalFields,
  CreateOptions,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { generateConnectionId } from "../utils/entity-id";
import { enforceToSql } from "../utils/configInheritance";

export function create(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    params: ConnectionInsert & ConnectionInternalFields,
    options?: CreateOptions,
  ): Promise<Connection> => {
    const importMetadata = options?.importMetadata;
    const { is_system, enforce, self_service, ...rest } = params;
    // `enabled_clients` is a virtual field surfaced via the join table; it has
    // no column on `connections` and would break the SQL insert.
    delete rest.enabled_clients;

    const now = new Date().toISOString();
    const connection: Connection = {
      ...rest,
      id: importMetadata?.id ?? rest.id ?? generateConnectionId(),
      is_system: is_system ? true : undefined,
      ...(enforce !== undefined ? { enforce } : {}),
      ...(self_service ? { self_service } : {}),
      created_at: importMetadata?.created_at ?? now,
      updated_at: importMetadata?.updated_at ?? now,
    };

    await db
      .insertInto("connections")
      .values({
        ...connection,
        is_system: is_system ? 1 : 0,
        enforce: enforceToSql(enforce),
        // The connection options will have many different properties depending on the strategy
        options: JSON.stringify(connection.options || {}),
        self_service: self_service ? JSON.stringify(self_service) : null,
        tenant_id,
      })
      .execute();

    return connection;
  };
}
