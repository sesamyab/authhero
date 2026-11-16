/**
 * True for client_ids that are http(s) URLs: Client ID Metadata Documents
 * (CIMD). Unlike generated client_ids, a URL client_id is not globally unique:
 * every tenant that uses the client gets its own `clients` stub row with the
 * same client_id, so a lookup by client_id alone can't identify the tenant.
 */
export function isUrlClientId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}
