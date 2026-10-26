/**
 * Collects per-entity `errors` from a sync-defaults apply result. The seed runs
 * with `continueOnError`, so the tenant worker returns a 2xx (no rejection)
 * even when individual entities fail — a clean resolve is therefore not proof
 * the seed landed. Walk the result's entity outcomes and surface any collected
 * errors so a partially-seeded tenant isn't marked `ready`.
 *
 * Shared between the inline tenant hook and the durable workflow's
 * seed-defaults step (issue #1026 phase 2).
 */
export function collectSyncDefaultsErrors(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];
  const errors: string[] = [];
  const collect = (outcome: unknown) => {
    if (
      typeof outcome === "object" &&
      outcome !== null &&
      "errors" in outcome &&
      Array.isArray(outcome.errors)
    ) {
      for (const err of outcome.errors) {
        if (typeof err === "string") errors.push(err);
      }
    }
  };
  for (const [key, outcome] of Object.entries(result)) {
    collect(outcome);
    // A resolved-config block nests its per-entity outcomes one level down.
    if (
      key === "resolved" &&
      typeof outcome === "object" &&
      outcome !== null &&
      "entities" in outcome &&
      typeof outcome.entities === "object" &&
      outcome.entities !== null
    ) {
      for (const entity of Object.values(outcome.entities)) collect(entity);
    }
  }
  return errors;
}
