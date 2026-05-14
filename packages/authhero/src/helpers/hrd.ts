import { type Connection } from "@authhero/adapter-interfaces";
import { BUILTIN_STRATEGIES, type StrategyHandler } from "../strategies";

export function findHrdConnection(
  email: string,
  connections: readonly Connection[],
  envStrategies?: Record<string, StrategyHandler>,
): Connection | undefined {
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain) return undefined;

  const matches = connections.filter((c) => {
    // Only route HRD to strategies that have a registered redirect handler.
    // This excludes Username-Password, email, sms, and SAMLP (which uses a
    // separate, non-connectionAuth path).
    const isRegistered =
      c.strategy in BUILTIN_STRATEGIES ||
      (envStrategies !== undefined && c.strategy in envStrategies);
    if (!isRegistered) return false;
    const aliases = c.options?.domain_aliases;
    if (!aliases?.length) return false;
    return aliases.some((d) => d.trim().toLowerCase() === domain);
  });

  // If multiple connections claim the same domain, treat as ambiguous and
  // skip HRD rather than silently routing to whichever happened to be first.
  return matches.length === 1 ? matches[0] : undefined;
}
