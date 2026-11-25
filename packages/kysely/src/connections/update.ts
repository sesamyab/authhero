import { Kysely } from "kysely";
import {
  ConnectionInsert,
  ConnectionInternalFields,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { enforceToSql } from "../utils/configInheritance";

export function update(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    connection_id: string,
    connection: Partial<ConnectionInsert> & ConnectionInternalFields,
  ): Promise<boolean> => {
    const { is_system, enforce, self_service, ...rest } = connection;
    // `enabled_clients` is virtual (join-table backed) and not a column.
    delete rest.enabled_clients;

    const sqlConnection = {
      ...rest,
      is_system: is_system !== undefined ? (is_system ? 1 : 0) : undefined,
      enforce: enforceToSql(enforce),
      updated_at: new Date().toISOString(),
    };

    await db
      .updateTable("connections")
      .set({
        ...sqlConnection,
        options: sqlConnection.options
          ? JSON.stringify(sqlConnection.options)
          : undefined,
        // `undefined` leaves the column alone; `null` clears it.
        self_service:
          self_service === undefined
            ? undefined
            : self_service === null
              ? null
              : JSON.stringify(self_service),
      })
      .where("connections.id", "=", connection_id)
      .where("connections.tenant_id", "=", tenant_id)
      .execute();

    return true;
  };
}
