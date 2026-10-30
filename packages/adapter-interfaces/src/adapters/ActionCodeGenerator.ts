export type ActionGenerationModel = "glm" | "deepseek" | "qwen";

/** Optional prompt-to-code adapter. Credentials and provider SDKs stay outside core. */
export interface ActionCodeGenerator {
  readonly models: readonly ActionGenerationModel[];
  generate(params: {
    tenantId: string;
    prompt: string;
    triggerId: string;
    /** Trusted TypeScript declarations for the selected trigger's sandbox API. */
    apiTypes: string;
    model: ActionGenerationModel;
  }): Promise<{ code: string }>;
}
