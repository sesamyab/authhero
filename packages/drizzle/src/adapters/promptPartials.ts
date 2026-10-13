import { and, eq } from "drizzle-orm";
import type {
  CreateOptions,
  PromptPartials,
  PromptPartialsAdapter,
} from "@authhero/adapter-interfaces";
import { promptPartials } from "../schema/sqlite";
import type { DrizzleDb } from "./types";

export function createPromptPartialsAdapter(
  db: DrizzleDb,
): PromptPartialsAdapter {
  return {
    async get(tenant_id, prompt) {
      const result = await db
        .select({ body: promptPartials.body })
        .from(promptPartials)
        .where(
          and(
            eq(promptPartials.tenant_id, tenant_id),
            eq(promptPartials.prompt, prompt),
          ),
        )
        .get();

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

      await db
        .insert(promptPartials)
        .values({
          tenant_id,
          prompt,
          body,
          created_at_ts: createdAt,
          updated_at_ts: updatedAt,
        })
        .onConflictDoUpdate({
          target: [promptPartials.tenant_id, promptPartials.prompt],
          set: {
            body,
            updated_at_ts: importedUpdatedAt ? updatedAt : now,
          },
        });
    },

    async delete(tenant_id, prompt) {
      await db
        .delete(promptPartials)
        .where(
          and(
            eq(promptPartials.tenant_id, tenant_id),
            eq(promptPartials.prompt, prompt),
          ),
        );
    },

    async list(tenant_id) {
      const rows = await db
        .select({ prompt: promptPartials.prompt })
        .from(promptPartials)
        .where(eq(promptPartials.tenant_id, tenant_id))
        .all();
      return rows.map(({ prompt }) => prompt);
    },
  };
}
