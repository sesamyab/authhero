import type {
  CreateOptions,
  PromptPartials,
  PromptPartialsAdapter,
} from "@authhero/adapter-interfaces";
import { promptPartialsKeys } from "../keys";
import type { DynamoDBBaseItem, DynamoDBContext } from "../types";
import { deleteItem, getItem, putItem, queryItems } from "../utils";

interface PromptPartialsItem extends DynamoDBBaseItem {
  tenant_id: string;
  prompt: string;
  body: string;
}

export function createPromptPartialsAdapter(
  ctx: DynamoDBContext,
): PromptPartialsAdapter {
  return {
    async get(tenant_id, prompt) {
      const item = await getItem<PromptPartialsItem>(
        ctx,
        promptPartialsKeys.pk(tenant_id),
        promptPartialsKeys.sk(prompt),
      );
      if (!item) return null;

      try {
        return JSON.parse(item.body) as PromptPartials;
      } catch {
        return null;
      }
    },

    async set(
      tenant_id: string,
      prompt: string,
      partials: PromptPartials,
      options?: CreateOptions,
    ) {
      const existing = await getItem<PromptPartialsItem>(
        ctx,
        promptPartialsKeys.pk(tenant_id),
        promptPartialsKeys.sk(prompt),
      );
      const now = new Date().toISOString();
      const createdAt =
        options?.importMetadata?.created_at ?? existing?.created_at ?? now;
      const updatedAt = options?.importMetadata?.updated_at ?? now;

      const item: PromptPartialsItem = {
        PK: promptPartialsKeys.pk(tenant_id),
        SK: promptPartialsKeys.sk(prompt),
        entityType: "PROMPT_PARTIALS",
        tenant_id,
        prompt,
        body: JSON.stringify(partials),
        created_at: createdAt,
        updated_at: updatedAt,
      };
      await putItem(ctx, item);
    },

    async delete(tenant_id, prompt) {
      await deleteItem(
        ctx,
        promptPartialsKeys.pk(tenant_id),
        promptPartialsKeys.sk(prompt),
      );
    },

    async list(tenant_id) {
      const result = await queryItems<PromptPartialsItem>(
        ctx,
        promptPartialsKeys.pk(tenant_id),
        { skPrefix: promptPartialsKeys.skPrefix() },
      );
      return result.items.map(({ prompt }) => prompt);
    },
  };
}
