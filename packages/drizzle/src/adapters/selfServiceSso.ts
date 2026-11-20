import { and, asc, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import {
  connectionDomainFromRow,
  normalizeConnectionDomain,
  selfServiceProfileCustomTextFromJson,
  selfServiceProfileFromRow,
  selfServiceProfileUpdateToRow,
  ssoAccessTicketFromRow,
  ssoAccessTicketToRow,
} from "@authhero/adapter-interfaces";
import type {
  ConnectionDomain,
  ConnectionDomainInsert,
  ConnectionDomainUpdate,
  ConnectionDomainsAdapter,
  CreateOptions,
  ListConnectionDomainsParams,
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
import {
  connectionDomains,
  selfServiceProfileCustomTexts,
  selfServiceProfiles,
  ssoAccessTickets,
} from "../schema/sqlite";
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
      // One atomic unit, so a failure leaves the profile, its tickets and its
      // custom text as they were. The foreign keys also cascade from the
      // profile where SQLite enforces them (D1 does).
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
        db
          .delete(selfServiceProfileCustomTexts)
          .where(
            and(
              eq(selfServiceProfileCustomTexts.tenant_id, tenant_id),
              eq(selfServiceProfileCustomTexts.profile_id, id),
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
        .select({ custom_text: selfServiceProfileCustomTexts.custom_text })
        .from(selfServiceProfileCustomTexts)
        .where(
          and(
            eq(selfServiceProfileCustomTexts.tenant_id, tenant_id),
            eq(selfServiceProfileCustomTexts.profile_id, profile_id),
            eq(selfServiceProfileCustomTexts.language, language),
            eq(selfServiceProfileCustomTexts.page, page),
          ),
        )
        .limit(1);
      return selfServiceProfileCustomTextFromJson(rows[0]?.custom_text ?? null);
    },

    async setCustomText(
      tenant_id: string,
      profile_id: string,
      language: string,
      page: string,
      custom_text: SelfServiceProfileCustomText,
    ): Promise<void> {
      const now = new Date().toISOString();
      const json = JSON.stringify(custom_text);
      await db
        .insert(selfServiceProfileCustomTexts)
        .values({
          tenant_id,
          profile_id,
          language,
          page,
          custom_text: json,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            selfServiceProfileCustomTexts.tenant_id,
            selfServiceProfileCustomTexts.profile_id,
            selfServiceProfileCustomTexts.language,
            selfServiceProfileCustomTexts.page,
          ],
          set: { custom_text: json, updated_at: now },
        });
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

export function createConnectionDomainsAdapter(
  db: DrizzleDb,
): ConnectionDomainsAdapter {
  const byId = (tenant_id: string, id: string) =>
    and(
      eq(connectionDomains.tenant_id, tenant_id),
      eq(connectionDomains.id, id),
    );

  return {
    async create(
      tenant_id: string,
      input: ConnectionDomainInsert,
    ): Promise<ConnectionDomain> {
      const now = new Date().toISOString();
      const row = {
        id: `cd_${generateId()}`,
        tenant_id,
        connection_id: input.connection_id,
        domain: normalizeConnectionDomain(input.domain),
        status: input.status ?? "pending",
        verification_value: input.verification_value,
        verified_at: input.verified_at ?? null,
        created_at: now,
        updated_at: now,
      };
      await db.insert(connectionDomains).values(row);
      return connectionDomainFromRow(row);
    },

    async get(tenant_id: string, id: string): Promise<ConnectionDomain | null> {
      const rows = await db
        .select()
        .from(connectionDomains)
        .where(byId(tenant_id, id))
        .limit(1);
      return rows[0] ? connectionDomainFromRow(rows[0]) : null;
    },

    async list(
      tenant_id: string,
      params?: ListConnectionDomainsParams,
    ): Promise<ConnectionDomain[]> {
      const conditions = [eq(connectionDomains.tenant_id, tenant_id)];
      if (params?.connection_id !== undefined)
        conditions.push(
          eq(connectionDomains.connection_id, params.connection_id),
        );
      if (params?.domain !== undefined)
        conditions.push(
          eq(
            connectionDomains.domain,
            normalizeConnectionDomain(params.domain),
          ),
        );
      const rows = await db
        .select()
        .from(connectionDomains)
        .where(and(...conditions))
        .orderBy(asc(connectionDomains.created_at), asc(connectionDomains.id));
      return rows.map(connectionDomainFromRow);
    },

    async update(
      tenant_id: string,
      id: string,
      input: ConnectionDomainUpdate,
    ): Promise<boolean> {
      const set: Partial<typeof connectionDomains.$inferInsert> = {
        updated_at: new Date().toISOString(),
      };
      if (input.status !== undefined) set.status = input.status;
      if (input.verification_value !== undefined)
        set.verification_value = input.verification_value;
      if (input.verified_at !== undefined) set.verified_at = input.verified_at;
      const updated = await db
        .update(connectionDomains)
        .set(set)
        .where(byId(tenant_id, id))
        .returning({ id: connectionDomains.id });
      return updated.length > 0;
    },

    async remove(tenant_id: string, id: string): Promise<boolean> {
      const deleted = await db
        .delete(connectionDomains)
        .where(byId(tenant_id, id))
        .returning({ id: connectionDomains.id });
      return deleted.length > 0;
    },
  };
}
