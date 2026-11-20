import { Kysely } from "kysely";
import { customAlphabet } from "nanoid";
import {
  CreateOptions,
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
  selfServiceProfileCustomTextFromRow,
  selfServiceProfileCustomTextToRow,
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
        custom_text: null,
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
      // One transaction, so a failure leaves the profile and its tickets as
      // they were. Custom text is a column of the profile.
      return db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("sso_access_tickets")
          .where("tenant_id", "=", tenant_id)
          .where("profile_id", "=", id)
          .execute();
        const result = await trx
          .deleteFrom("self_service_profiles")
          .where("tenant_id", "=", tenant_id)
          .where("id", "=", id)
          .executeTakeFirst();
        return Number(result.numDeletedRows) > 0;
      });
    },

    async getCustomText(
      tenant_id: string,
      profile_id: string,
      language: string,
      page: string,
    ): Promise<SelfServiceProfileCustomText> {
      const row = await db
        .selectFrom("self_service_profiles")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", profile_id)
        .select("custom_text")
        .executeTakeFirst();
      return selfServiceProfileCustomTextFromRow(
        row?.custom_text ?? null,
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
      const row = await db
        .selectFrom("self_service_profiles")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", profile_id)
        .select("custom_text")
        .executeTakeFirst();
      if (!row) return false;
      const result = await db
        .updateTable("self_service_profiles")
        .where("tenant_id", "=", tenant_id)
        .where("id", "=", profile_id)
        .set({
          custom_text: selfServiceProfileCustomTextToRow(
            row.custom_text,
            language,
            page,
            custom_text,
          ),
          updated_at: new Date().toISOString(),
        })
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
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
