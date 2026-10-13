import type {
  CreateOptions,
  PromptPartials,
  PromptPartialsAdapter,
} from "@authhero/adapter-interfaces";
import { Kysely } from "kysely";
import { Database } from "../db";

export function createPromptPartialsAdapter(
  db: Kysely<Database>,
): PromptPartialsAdapter {
  return {
    async get(tenant_id, prompt) {
      const result = await db
        .selectFrom("prompt_partials")
        .select("body")
        .where("tenant_id", "=", tenant_id)
        .where("prompt", "=", prompt)
        .executeTakeFirst();

      if (!result) return null;

      try {
        return JSON.parse(result.body) as PromptPartials;
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
      const now = Date.now();
      const importedCreatedAt = options?.importMetadata?.created_at;
      const importedUpdatedAt = options?.importMetadata?.updated_at;
      const createdAt = importedCreatedAt
        ? new Date(importedCreatedAt).getTime()
        : now;
      const updatedAt = importedUpdatedAt
        ? new Date(importedUpdatedAt).getTime()
        : createdAt;
      const body = JSON.stringify(partials);
      const existing = await db
        .selectFrom("prompt_partials")
        .select("tenant_id")
        .where("tenant_id", "=", tenant_id)
        .where("prompt", "=", prompt)
        .executeTakeFirst();

      if (existing) {
        await db
          .updateTable("prompt_partials")
          .set({
            body,
            ...(importedCreatedAt ? { created_at_ts: createdAt } : undefined),
            updated_at_ts: importedUpdatedAt ? updatedAt : now,
          })
          .where("tenant_id", "=", tenant_id)
          .where("prompt", "=", prompt)
          .execute();
      } else {
        await db
          .insertInto("prompt_partials")
          .values({
            tenant_id,
            prompt,
            body,
            created_at_ts: createdAt,
            updated_at_ts: updatedAt,
          })
          .execute();
      }
    },

    async delete(tenant_id, prompt) {
      await db
        .deleteFrom("prompt_partials")
        .where("tenant_id", "=", tenant_id)
        .where("prompt", "=", prompt)
        .execute();
    },

    async list(tenant_id) {
      const rows = await db
        .selectFrom("prompt_partials")
        .select("prompt")
        .where("tenant_id", "=", tenant_id)
        .execute();
      return rows.map(({ prompt }) => prompt);
    },
  };
}
