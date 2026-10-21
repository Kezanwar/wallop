/** What an unversioned build reports — i.e. anything run locally. */
export const DEV_VERSION = "dev";

/**
 * The build identity stamped onto rows we may later need to explain.
 *
 * Forensic provenance, not a feature flag: the generation path (prompt
 * wrapper, crop, provider params, model default) moves over time, so "why
 * does this old design look like that?" is answered by checking out the
 * version it carries. Never branch on this — code that behaves differently
 * per version is a flag, and belongs somewhere else.
 *
 * Deployed builds set APP_VERSION to a CalVer release string; locally it is
 * "dev", which is the honest answer for a working tree that may be anything.
 */
export function getAppVersion(): string {
  return process.env.APP_VERSION?.trim() || DEV_VERSION;
}
