/**
 * The HTTP status of a failed request, whichever client made it: react-admin's
 * `HttpError` reports `status`, the management SDK's errors `statusCode`, and
 * the admin's own client (`authorizedHttpClient`) `httpStatus`, which is not
 * `status` on purpose so react-admin does not sign the user out on a 403.
 * Undefined for anything else, such as a network failure.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, statusCode, httpStatus } = error as {
    status?: unknown;
    statusCode?: unknown;
    httpStatus?: unknown;
  };
  if (typeof status === "number") return status;
  if (typeof statusCode === "number") return statusCode;
  if (typeof httpStatus === "number") return httpStatus;
  return undefined;
}
