export { resolveTenantChain } from "./chain";
export { effectiveOverride, effectiveScope, mergeConfig } from "./merge";
export { computeLegacyConfig } from "./legacy";
export { readConfigRows } from "./read";
export { compareShadow, diffConfig } from "./shadow";
export type { ShadowDiff } from "./shadow";
export { createShadowReporter } from "./report";
export type { InheritanceShadowOptions, ShadowReporter } from "./report";
export type { ConfigRows, ConfigEntity, ResolvedConfig } from "./types";
