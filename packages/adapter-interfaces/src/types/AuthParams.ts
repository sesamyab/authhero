import { z } from "@hono/zod-openapi";

export enum AuthorizationResponseType {
  TOKEN = "token",
  ID_TOKEN = "id_token",
  TOKEN_ID_TOKEN = "id_token token",
  CODE = "code",
  CODE_ID_TOKEN = "code id_token",
  CODE_TOKEN = "code token",
  CODE_ID_TOKEN_TOKEN = "code id_token token",
}

export enum AuthorizationResponseMode {
  QUERY = "query",
  FRAGMENT = "fragment",
  FORM_POST = "form_post",
  WEB_MESSAGE = "web_message",
  SAML_POST = "saml_post",
}

export enum CodeChallengeMethod {
  S256 = "S256",
  Plain = "plain",
}

// OIDC Core 5.5 — `claims` request parameter. A member is either `null`
// ("requested with default behaviour") or an object that may carry
// `essential`, `value`, `values` markers. Unknown properties on the member
// object are allowed by spec but stripped on parse — we never use them.
const claimsRequestMemberSchema = z
  .union([
    z.null(),
    z.object({
      essential: z.boolean().optional(),
      value: z.unknown().optional(),
      values: z.array(z.unknown()).optional(),
    }),
  ])
  .nullable();

export const claimsRequestSchema = z.object({
  userinfo: z.record(z.string(), claimsRequestMemberSchema).optional(),
  id_token: z.record(z.string(), claimsRequestMemberSchema).optional(),
});

export type ClaimsRequest = z.infer<typeof claimsRequestSchema>;

export const authParamsSchema = z.object({
  client_id: z.string(),
  act_as: z.string().optional(),
  response_type: z.nativeEnum(AuthorizationResponseType).optional(),
  response_mode: z.nativeEnum(AuthorizationResponseMode).optional(),
  redirect_uri: z.string().optional(),
  audience: z.string().optional(),
  organization: z.string().optional(),
  state: z.string().optional(),
  nonce: z.string().optional(),
  scope: z.string().optional(),
  prompt: z.string().optional(),
  code_challenge_method: z.nativeEnum(CodeChallengeMethod).optional(),
  code_challenge: z.string().optional(),
  username: z.string().optional(),
  ui_locales: z.string().optional(),
  // OIDC Core 3.1.2.1 - max_age specifies the allowable elapsed time in seconds
  // since the last time the End-User was actively authenticated
  max_age: z.number().optional(),
  // OIDC Core 3.1.2.1 - acr_values is a space-separated string of requested
  // Authentication Context Class Reference values
  acr_values: z.string().optional(),
  // OIDC Core 5.5 - parsed `claims` request parameter (individual claim
  // requests for the id_token and/or userinfo response).
  claims: claimsRequestSchema.optional(),
  // The following fields are not available in Auth0
  vendor_id: z.string().optional(),
});

export type AuthParams = z.infer<typeof authParamsSchema>;
