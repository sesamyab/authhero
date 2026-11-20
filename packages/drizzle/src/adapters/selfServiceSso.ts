import { and, asc, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import {
  selfServiceProfileCustomTextFromRow,
  selfServiceProfileCustomTextToRow,
  selfServiceProfileFromRow,
  selfServiceProfileUpdateToRow,
  ssoAccessTicketFromRow,
  ssoAccessTicketToRow,
} from "@authhero/adapter-interfaces";
import type {
  CreateOptions,
  SelfServiceProfile,
  SelfServiceProfileCustomText,
  SelfServiceProfileInsert,
  SelfServiceProfileUpdate,
  SelfServiceProfilesAdapter,
  SsoAccessTicket,
  SsoAccessTicketInsert,
  SsoAccessTicketUpdate,
  SsoAccessTicketsAdapter,
} from "@authhero/adapter-interfaces";
import { selfServiceProfiles, ssoAccessTickets } from "../schema/sqlite";
import type { DrizzleDb } from "./types";
import { runAtomic } from "./atomic";

const generateId = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  22,
);

export function createSelfServiceProfilesAdapter(
  db: DrizzleDb,
): SelfServiceProfilesAdapter {
  const byId = (tenant_id: string, id: string) =>
    and(
      eq(selfServiceProfiles.tenant_id, tenant_id),
      eq(selfServiceProfiles.id, id),
    );

  return {
    async create(
      tenant_id: string,
      input: SelfServiceProfileInsert,
      options?: CreateOptions,
    ): Promise<SelfServiceProfile> {
      const importMetadata = options?.importMetadata;
      const now = new Date().toISOString();
      const row = {
        id: importMetadata?.id ?? `ssp_${generateId()}`,
        tenant_id,
        name: input.name,
        description: input.description ?? null,
        allowed_strategies: input.allowed_strategies
          ? JSON.stringify(input.allowed_strategies)
          : null,
        user_attributes: input.user_attributes
          ? JSON.stringify(input.user_attributes)
          : null,
        branding: input.branding ? JSON.stringify(input.branding) : null,
        custom_text: null,
        created_at: importMetadata?.created_at ?? now,
        updated_at: importMetadata?.updated_at ?? now,
      };
      await db.insert(selfServiceProfiles).values(row);
      return selfServiceProfileFromRow(row);
    },

    async get(
      tenant_id: string,
      id: string,
    ): Promise<SelfServiceProfile | null> {
      const rows = await db
        .select()
        .from(selfServiceProfiles)
        .where(byId(tenant_id, id))
        .limit(1);
      return rows[0] ? selfServiceProfileFromRow(rows[0]) : null;
    },

    async list(tenant_id: string): Promise<SelfServiceProfile[]> {
      const rows = await db
        .select()
        .from(selfServiceProfiles)
        .where(eq(selfServiceProfiles.tenant_id, tenant_id))
        .orderBy(
          asc(selfServiceProfiles.created_at),
          asc(selfServiceProfiles.id),
        );
      return rows.map(selfServiceProfileFromRow);
    },

    async update(
      tenant_id: string,
      id: string,
      input: SelfServiceProfileUpdate,
    ): Promise<boolean> {
      const updated = await db
        .update(selfServiceProfiles)
        .set(selfServiceProfileUpdateToRow(input, new Date().toISOString()))
        .where(byId(tenant_id, id))
        .returning({ id: selfServiceProfiles.id });
      return updated.length > 0;
    },

    async remove(tenant_id: string, id: string): Promise<boolean> {
      // One atomic unit, so a failure leaves the profile and its tickets as
      // they were. The foreign key also cascades from the profile where
      // SQLite enforces it (D1 does). Custom text is a column of the profile.
      const existing = await db
        .select({ id: selfServiceProfiles.id })
        .from(selfServiceProfiles)
        .where(byId(tenant_id, id))
        .limit(1);
      if (existing.length === 0) return false;
      await runAtomic(db, [
        db
          .delete(ssoAccessTickets)
          .where(
            and(
              eq(ssoAccessTickets.tenant_id, tenant_id),
              eq(ssoAccessTickets.profile_id, id),
            ),
          ),
        db.delete(selfServiceProfiles).where(byId(tenant_id, id)),
      ]);
      return true;
    },

    async getCustomText(
      tenant_id: string,
      profile_id: string,
      language: string,
      page: string,
    ): Promise<SelfServiceProfileCustomText> {
      const rows = await db
        .select({ custom_text: selfServiceProfiles.custom_text })
        .from(selfServiceProfiles)
        .where(byId(tenant_id, profile_id))
        .limit(1);
      return selfServiceProfileCustomTextFromRow(
        rows[0]?.custom_text ?? null,
        language,
        page,
      );
    },

    async setCustomText(
      tenant_id: string,
      profile_id: string,
      language: string,
      page: string,
      custom_text: SelfServiceProfileCustomText,
    ): Promise<boolean> {
      const rows = await db
        .select({ custom_text: selfServiceProfiles.custom_text })
        .from(selfServiceProfiles)
        .where(byId(tenant_id, profile_id))
        .limit(1);
      const row = rows[0];
      if (!row) return false;
      const updated = await db
        .update(selfServiceProfiles)
        .set({
          custom_text: selfServiceProfileCustomTextToRow(
            row.custom_text,
            language,
            page,
            custom_text,
          ),
          updated_at: new Date().toISOString(),
        })
        .where(byId(tenant_id, profile_id))
        .returning({ id: selfServiceProfiles.id });
      return updated.length > 0;
    },
  };
}

export function createSsoAccessTicketsAdapter(
  db: DrizzleDb,
): SsoAccessTicketsAdapter {
  const byId = (tenant_id: string, id: string) =>
    and(eq(ssoAccessTickets.tenant_id, tenant_id), eq(ssoAccessTickets.id, id));

  return {
    async create(
      tenant_id: string,
      input: SsoAccessTicketInsert,
    ): Promise<SsoAccessTicket> {
      const row = ssoAccessTicketToRow(
        tenant_id,
        `sst_${generateId()}`,
        input,
        new Date().toISOString(),
      );
      await db.insert(ssoAccessTickets).values(row);
      return ssoAccessTicketFromRow(row);
    },

    async get(tenant_id: string, id: string): Promise<SsoAccessTicket | null> {
      const rows = await db
        .select()
        .from(ssoAccessTickets)
        .where(byId(tenant_id, id))
        .limit(1);
      return rows[0] ? ssoAccessTicketFromRow(rows[0]) : null;
    },

    async getByTicketHash(
      tenant_id: string,
      ticket_hash: string,
    ): Promise<SsoAccessTicket | null> {
      const rows = await db
        .select()
        .from(ssoAccessTickets)
        .where(
          and(
            eq(ssoAccessTickets.tenant_id, tenant_id),
            eq(ssoAccessTickets.ticket_hash, ticket_hash),
          ),
        )
        .limit(1);
      return rows[0] ? ssoAccessTicketFromRow(rows[0]) : null;
    },

    async update(
      tenant_id: string,
      id: string,
      input: SsoAccessTicketUpdate,
    ): Promise<boolean> {
      const set: Partial<typeof ssoAccessTickets.$inferInsert> = {
        updated_at: new Date().toISOString(),
      };
      if (input.connection_id !== undefined)
        set.connection_id = input.connection_id;
      if (input.revoked_at !== undefined) set.revoked_at = input.revoked_at;
      if (input.completed_at !== undefined)
        set.completed_at = input.completed_at;
      const updated = await db
        .update(ssoAccessTickets)
        .set(set)
        .where(byId(tenant_id, id))
        .returning({ id: ssoAccessTickets.id });
      return updated.length > 0;
    },

    async remove(tenant_id: string, id: string): Promise<boolean> {
      const deleted = await db
        .delete(ssoAccessTickets)
        .where(byId(tenant_id, id))
        .returning({ id: ssoAccessTickets.id });
      return deleted.length > 0;
    },
  };
}
