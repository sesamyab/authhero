import {
  AuthenticationMethodsAdapter,
  AuthenticationMethod,
  AuthenticationMethodInsert,
  AuthenticationMethodUpdate,
  authenticationMethodSchema,
} from "@authhero/adapter-interfaces";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { authenticationMethodKeys } from "../keys";
import {
  getItem,
  putItem,
  deleteItem,
  queryItems,
  updateItem,
  stripDynamoDBFields,
  removeNullProperties,
} from "../utils";
import { nanoid } from "nanoid";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

interface AuthenticationMethodItem extends DynamoDBBaseItem {
  id: string;
  tenant_id: string;
  user_id: string;
  type: string;
  phone_number?: string;
  totp_secret?: string;
  totp_last_step?: number;
  credential_id?: string;
  public_key?: string;
  sign_count?: number;
  credential_backed_up?: boolean;
  transports?: string[];
  friendly_name?: string;
  confirmed: boolean;
  created_at: string;
  updated_at: string;
}

function toAuthenticationMethod(
  item: AuthenticationMethodItem,
): AuthenticationMethod {
  const { tenant_id, ...rest } = stripDynamoDBFields(item);
  return authenticationMethodSchema.parse(removeNullProperties(rest));
}

export function createAuthenticationMethodsAdapter(
  ctx: DynamoDBContext,
): AuthenticationMethodsAdapter {
  return {
    async create(
      tenantId: string,
      method: AuthenticationMethodInsert,
    ): Promise<AuthenticationMethod> {
      const now = new Date().toISOString();
      const id = nanoid();

      const item: AuthenticationMethodItem = {
        PK: authenticationMethodKeys.pk(tenantId),
        SK: authenticationMethodKeys.sk(id),
        GSI1PK: authenticationMethodKeys.gsi1pk(tenantId, method.user_id),
        GSI1SK: authenticationMethodKeys.gsi1sk(id),
        entityType: "AUTHENTICATION_METHOD",
        id,
        tenant_id: tenantId,
        user_id: method.user_id,
        type: method.type,
        phone_number: method.phone_number,
        totp_secret: method.totp_secret,
        totp_last_step: method.totp_last_step,
        credential_id: method.credential_id,
        public_key: method.public_key,
        sign_count: method.sign_count,
        credential_backed_up: method.credential_backed_up,
        transports: method.transports,
        friendly_name: method.friendly_name,
        confirmed: method.confirmed ?? false,
        created_at: now,
        updated_at: now,
      };

      const authMethod = toAuthenticationMethod(item);
      await putItem(ctx, item);
      return authMethod;
    },

    async get(
      tenantId: string,
      methodId: string,
    ): Promise<AuthenticationMethod | null> {
      const item = await getItem<AuthenticationMethodItem>(
        ctx,
        authenticationMethodKeys.pk(tenantId),
        authenticationMethodKeys.sk(methodId),
      );

      if (!item) return null;
      return toAuthenticationMethod(item);
    },

    async getByCredentialId(
      tenantId: string,
      credentialId: string,
    ): Promise<AuthenticationMethod | null> {
      const result = await queryItems<AuthenticationMethodItem>(
        ctx,
        authenticationMethodKeys.pk(tenantId),
        {
          skPrefix: "AUTHENTICATION_METHOD#",
        },
      );

      const item = result.items.find((i) => i.credential_id === credentialId);

      if (!item) return null;
      return toAuthenticationMethod(item);
    },

    async list(
      tenantId: string,
      userId: string,
    ): Promise<AuthenticationMethod[]> {
      const result = await queryItems<AuthenticationMethodItem>(
        ctx,
        authenticationMethodKeys.gsi1pk(tenantId, userId),
        {
          skPrefix: authenticationMethodKeys.gsi1skPrefix(),
          indexName: "GSI1",
        },
      );

      return result.items.map(toAuthenticationMethod);
    },

    async update(
      tenantId: string,
      methodId: string,
      data: AuthenticationMethodUpdate,
    ): Promise<AuthenticationMethod> {
      const existing = await this.get(tenantId, methodId);
      if (!existing) {
        throw new Error(`Authentication method ${methodId} not found`);
      }

      const merged = {
        ...existing,
        ...data,
        updated_at: new Date().toISOString(),
      };
      authenticationMethodSchema.parse(merged);

      const updates: Record<string, unknown> = {
        updated_at: merged.updated_at,
      };

      if (data.phone_number !== undefined)
        updates.phone_number = data.phone_number;
      if (data.totp_secret !== undefined)
        updates.totp_secret = data.totp_secret;
      if (data.credential_id !== undefined)
        updates.credential_id = data.credential_id;
      if (data.public_key !== undefined) updates.public_key = data.public_key;
      if (data.sign_count !== undefined) updates.sign_count = data.sign_count;
      if (data.credential_backed_up !== undefined)
        updates.credential_backed_up = data.credential_backed_up;
      if (data.transports !== undefined) updates.transports = data.transports;
      if (data.friendly_name !== undefined)
        updates.friendly_name = data.friendly_name;
      if (data.confirmed !== undefined) updates.confirmed = data.confirmed;

      await updateItem(
        ctx,
        authenticationMethodKeys.pk(tenantId),
        authenticationMethodKeys.sk(methodId),
        updates,
      );

      return authenticationMethodSchema.parse(merged);
    },

    async consumeTotpStep(
      tenantId: string,
      methodId: string,
      step: number,
    ): Promise<boolean> {
      // Conditional write, like codes.consume: DynamoDB evaluates the
      // condition and applies the update atomically, so two concurrent
      // submits of the same code cannot both succeed.
      try {
        await ctx.client.send(
          new UpdateCommand({
            TableName: ctx.tableName,
            Key: {
              PK: authenticationMethodKeys.pk(tenantId),
              SK: authenticationMethodKeys.sk(methodId),
            },
            UpdateExpression: "SET #step = :step, #updated_at = :now",
            ConditionExpression:
              "attribute_exists(PK) AND (attribute_not_exists(#step) OR #step = :null OR #step < :step)",
            ExpressionAttributeNames: {
              "#step": "totp_last_step",
              "#updated_at": "updated_at",
            },
            ExpressionAttributeValues: {
              ":step": step,
              ":now": new Date().toISOString(),
              ":null": null,
            },
          }),
        );
        return true;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "ConditionalCheckFailedException"
        ) {
          return false;
        }
        throw err;
      }
    },

    async remove(tenantId: string, methodId: string): Promise<boolean> {
      return deleteItem(
        ctx,
        authenticationMethodKeys.pk(tenantId),
        authenticationMethodKeys.sk(methodId),
      );
    },
  };
}
