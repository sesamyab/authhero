import { type Connection } from "@authhero/adapter-interfaces";
import { BUILTIN_STRATEGIES, type StrategyHandler } from "../strategies";

export function findHrdConnection(
  email: string,
  connections: readonly Connection[],
  envStrategies?: Record<string, StrategyHandler>,
): Connection | undefined {
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return undefined;

  return connections.find((c) => {
    // Only route HRD to strategies that have a registered redirect handler.
    // This excludes Username-Password, email, sms, and SAMLP (which uses a
    // separate, non-connectionAuth path).
    const isRegistered =
      c.strategy in BUILTIN_STRATEGIES ||
      (envStrategies !== undefined && c.strategy in envStrategies);
    if (!isRegistered) return false;
    const aliases = c.options?.domain_aliases;
    if (!aliases?.length) return false;
    return aliases.some((d) => d.toLowerCase() === domain);
  });
}
