/**
 * The HTTP status of a failed request, whichever client made it: react-admin's
 * `HttpError` reports `status`, the management SDK's errors `statusCode`.
 * Undefined for anything else, such as a network failure.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusCode } = error as {
    status?: unknown;
    statusCode?: unknown;
  };
  if (typeof status === "number") return status;
  if (typeof statusCode === "number") return statusCode;
  return undefined;
}
