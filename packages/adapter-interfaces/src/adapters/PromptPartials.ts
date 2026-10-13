import { CreateOptions, PromptPartials } from "../types";

export interface PromptPartialsAdapter {
  get(tenant_id: string, prompt: string): Promise<PromptPartials | null>;

  /** Replace all partials stored for a prompt. */
  set(
    tenant_id: string,
    prompt: string,
    partials: PromptPartials,
    options?: CreateOptions,
  ): Promise<void>;

  delete(tenant_id: string, prompt: string): Promise<void>;

  /** List prompts with stored partials for tenant export. */
  list(tenant_id: string): Promise<string[]>;
}
