/**
 * Percent-encodes each segment of a storage key for use in a URL path, keeping
 * `/` separators. Tenant ids may contain characters such as `#` or `?`.
 */
export function storageKeyToUrlPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
