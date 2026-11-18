import { Connection } from "@authhero/adapter-interfaces";
import { removeNullProperties } from "../helpers/remove-nulls";
import { Database } from "../db";
import { Selectable } from "kysely";
import { enforceFromSql } from "../utils/configInheritance";

type DbConnection = Selectable<Database["connections"]>;

/**
 * Transform a raw database connection row to a Connection object.
 * Handles:
 * - Converting is_system from number (0/1) to boolean/undefined
 * - Parsing the JSON options field
 * - Removing null properties
 */
export function transformConnection(dbConnection: DbConnection): Connection {
  const { is_system, enforce, self_service, ...rest } = dbConnection;
  return removeNullProperties({
    ...rest,
    self_service: parseSelfService(self_service),
    is_system: is_system ? true : undefined,
    enforce: enforceFromSql(enforce as number | null | undefined),
    options:
      typeof dbConnection.options === "string"
        ? JSON.parse(dbConnection.options)
        : {},
  });
}

/** The stored Self-Service SSO JSON, or `undefined` when unset or unreadable. */
function parseSelfService(value: unknown): Connection["self_service"] {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Transform multiple raw database connection rows to Connection objects.
 */
export function transformConnections(
  dbConnections: DbConnection[],
): Connection[] {
  return dbConnections.map(transformConnection);
}
