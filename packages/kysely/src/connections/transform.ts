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
  const {
    is_system,
    enforce,
    self_service,
    show_as_button,
    is_domain_connection,
    ...rest
  } = dbConnection;
  return removeNullProperties({
    ...rest,
    show_as_button: intToBool(show_as_button),
    is_domain_connection: intToBool(is_domain_connection),
    self_service: parseSelfService(self_service),
    is_system: is_system ? true : undefined,
    enforce: enforceFromSql(enforce as number | null | undefined),
    options:
      typeof dbConnection.options === "string"
        ? JSON.parse(dbConnection.options)
        : {},
  });
}

/** Integer column (0/1/NULL) → boolean; NULL stays unset. */
function intToBool(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return Boolean(value);
}

/** Boolean → integer column; `undefined` leaves the column untouched/NULL. */
export function boolToInt(value: boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value ? 1 : 0;
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
