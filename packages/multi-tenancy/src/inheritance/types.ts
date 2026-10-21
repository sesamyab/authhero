import type {
  Action,
  Branding,
  Connection,
  EmailProvider,
  Hook,
  PromptSetting,
  ResourceServer,
} from "authhero";

/** Plain config rows for one tenant. Singletons are `null` when unset. */
export interface ConfigRows {
  connections: Connection[];
  resourceServers: ResourceServer[];
  hooks: Hook[];
  actions: Action[];
  emailProvider: EmailProvider | null;
  branding: Branding | null;
  promptSettings: PromptSetting | null;
}

export const emptyConfigRows = (): ConfigRows => ({
  connections: [],
  resourceServers: [],
  hooks: [],
  actions: [],
  emailProvider: null,
  branding: null,
  promptSettings: null,
});

export type ConfigEntity =
  | "connection"
  | "resourceServer"
  | "hook"
  | "action"
  | "emailProvider"
  | "branding"
  | "promptSettings";

/** Result of merging a parent chain into one tenant's config. */
export interface ResolvedConfig extends ConfigRows {
  /**
   * Keys (`<entity>:<key>`) of rows that came from a `platform`-scoped
   * ancestor row: merged so they can run, but hidden from the tenant.
   */
  hidden: string[];
}
