import { Kysely } from "kysely";
import { customAlphabet } from "nanoid";
import {
  ConnectionDomain,
  ConnectionDomainInsert,
  ConnectionDomainRow,
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
  SsoAccessTicketRow,
  SsoAccessTicketUpdate,
  SsoAccessTicketsAdapter,
  connectionDomainFromRow,
  normalizeConnectionDomain,
  selfServiceProfileCustomTextFromJson,
  selfServiceProfileFromRow,
  selfServiceProfileUpdateToRow,
  ssoAccessTicketFromRow,
  ssoAccessTicketToRow,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";

const generateId = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  22,
);

export function createSelfServiceProfilesAdapter(
  db: Kysely<Database>,
): SelfServiceProfilesAdapter {
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
      await db.insertInto("self_service_profiles").values(row).execute();
      return selfServiceProfileFromRow(row);
    },

    async get(
      tenant_id: string,
      id: string,
    ): Promise<SelfServiceProfile | null> {
      const row = await db
        .selectFrom("self_service_profiles")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .selectAll()
        .executeTakeFirst();
      return row ? selfServiceProfileFromRow(row) : null;
    },

    async list(tenant_id: string): Promise<SelfServiceProfile[]> {
      const rows = await db
        .selectFrom("self_service_profiles")
        .where("tenant_id", "=", tenant_id)
        .selectAll()
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(selfServiceProfileFromRow);
    },

    async update(
      tenant_id: string,
      id: string,
      input: SelfServiceProfileUpdate,
    ): Promise<boolean> {
      const result = await db
        .updateTable("self_service_profiles")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .set(selfServiceProfileUpdateToRow(input, new Date().toISOString()))
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async remove(tenant_id: string, id: string): Promise<boolean> {
      // Tickets first: a failure part-way leaves a profile with fewer usable
      // tickets, never a ticket without its profile.
      await db
        .deleteFrom("sso_access_tickets")
        .where("tenant_id", "=", tenant_id)
        .where("profile_id", "=", id)
        .execute();
      await db
        .deleteFrom("self_service_profile_custom_texts")
        .where("tenant_id", "=", tenant_id)
        .where("profile_id", "=", id)
        .execute();
      const result = await db
        .deleteFrom("self_service_profiles")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },

    async getCustomText(
      tenant_id: string,
      profile_id: string,
      language: string,
      page: string,
    ): Promise<SelfServiceProfileCustomText> {
      const row = await db
        .selectFrom("self_service_profile_custom_texts")
        .where("tenant_id", "=", tenant_id)
        .where("profile_id", "=", profile_id)
        .where("language", "=", language)
        .where("page", "=", page)
        .select("custom_text")
        .executeTakeFirst();
      return selfServiceProfileCustomTextFromJson(row?.custom_text ?? null);
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
      const result = await db
        .updateTable("self_service_profile_custom_texts")
        .where("tenant_id", "=", tenant_id)
        .where("profile_id", "=", profile_id)
        .where("language", "=", language)
        .where("page", "=", page)
        .set({ custom_text: json, updated_at: now })
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) > 0) return;
      await db
        .insertInto("self_service_profile_custom_texts")
        .values({
          tenant_id,
          profile_id,
          language,
          page,
          custom_text: json,
          created_at: now,
          updated_at: now,
        })
        .execute();
    },
  };
}

export function createSsoAccessTicketsAdapter(
  db: Kysely<Database>,
): SsoAccessTicketsAdapter {
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
      await db.insertInto("sso_access_tickets").values(row).execute();
      return ssoAccessTicketFromRow(row);
    },

    async get(tenant_id: string, id: string): Promise<SsoAccessTicket | null> {
      const row = await db
        .selectFrom("sso_access_tickets")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .selectAll()
        .executeTakeFirst();
      return row ? ssoAccessTicketFromRow(row) : null;
    },

    async getByTicketHash(
      tenant_id: string,
      ticket_hash: string,
    ): Promise<SsoAccessTicket | null> {
      const row = await db
        .selectFrom("sso_access_tickets")
        .where("tenant_id", "=", tenant_id)
        .where("ticket_hash", "=", ticket_hash)
        .selectAll()
        .executeTakeFirst();
      return row ? ssoAccessTicketFromRow(row) : null;
    },

    async update(
      tenant_id: string,
      id: string,
      input: SsoAccessTicketUpdate,
    ): Promise<boolean> {
      const set: Partial<SsoAccessTicketRow> = {
        updated_at: new Date().toISOString(),
      };
      if (input.connection_id !== undefined)
        set.connection_id = input.connection_id;
      if (input.revoked_at !== undefined) set.revoked_at = input.revoked_at;
      if (input.completed_at !== undefined)
        set.completed_at = input.completed_at;
      const result = await db
        .updateTable("sso_access_tickets")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .set(set)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async remove(tenant_id: string, id: string): Promise<boolean> {
      const result = await db
        .deleteFrom("sso_access_tickets")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}

export function createConnectionDomainsAdapter(
  db: Kysely<Database>,
): ConnectionDomainsAdapter {
  return {
    async create(
      tenant_id: string,
      input: ConnectionDomainInsert,
    ): Promise<ConnectionDomain> {
      const now = new Date().toISOString();
      const row: ConnectionDomainRow = {
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
      await db.insertInto("connection_domains").values(row).execute();
      return connectionDomainFromRow(row);
    },

    async get(tenant_id: string, id: string): Promise<ConnectionDomain | null> {
      const row = await db
        .selectFrom("connection_domains")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .selectAll()
        .executeTakeFirst();
      return row ? connectionDomainFromRow(row) : null;
    },

    async list(
      tenant_id: string,
      params?: ListConnectionDomainsParams,
    ): Promise<ConnectionDomain[]> {
      let query = db
        .selectFrom("connection_domains")
        .where("tenant_id", "=", tenant_id);
      if (params?.connection_id !== undefined)
        query = query.where("connection_id", "=", params.connection_id);
      if (params?.domain !== undefined)
        query = query.where(
          "domain",
          "=",
          normalizeConnectionDomain(params.domain),
        );
      const rows = await query
        .selectAll()
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute();
      return rows.map(connectionDomainFromRow);
    },

    async update(
      tenant_id: string,
      id: string,
      input: ConnectionDomainUpdate,
    ): Promise<boolean> {
      const set: Partial<ConnectionDomainRow> = {
        updated_at: new Date().toISOString(),
      };
      if (input.status !== undefined) set.status = input.status;
      if (input.verification_value !== undefined)
        set.verification_value = input.verification_value;
      if (input.verified_at !== undefined) set.verified_at = input.verified_at;
      const result = await db
        .updateTable("connection_domains")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .set(set)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async remove(tenant_id: string, id: string): Promise<boolean> {
      const result = await db
        .deleteFrom("connection_domains")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
