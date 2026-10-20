const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route params are whatever someone types in the URL bar. Postgres rejects a
 * malformed uuid with a cast error, which would surface as a 500 — this turns
 * "/session/banana" into the same 404 a stranger's id gets.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
