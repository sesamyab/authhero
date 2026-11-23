/**
 * Developer app setup page (#1776), served at /u2/self-service/app.
 *
 * An outside developer opens an invite link (an Initial Access Token minted
 * from an app-type preset) to register an app, or an edit link (a
 * Registration Access Token for one client) to update it. The landing route
 * in u2-routes.tsx verifies the link and starts a login session carrying
 * `state_data.self_service`; this screen re-checks the token on every request,
 * so revoking a link also stops an open page.
 *
 * Registration and updates go through the same code as RFC 7591/7592
 * (helpers/dcr/client-registration.ts), so the page enforces exactly what the
 * API enforces.
 */

import {
  LogTypes,
  isPlainObject,
  type Client,
  type ClientRegistrationToken,
  type FormNodeComponent,
  type UiScreen,
} from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenDefinition, ScreenResult } from "./types";
import { createTranslation } from "../../../i18n";
import { escapeHtml } from "../sanitization-utils";
import { logMessage } from "../../../helpers/logging";
import { getAuthUrl } from "../../../variables";
import {
  dcrRequestSchema,
  type DcrRequest,
} from "../../../helpers/dcr/metadata-mapping";
import {
  DcrMetadataError,
  registerClient,
  updateRegisteredClient,
  editPolicyAppType,
} from "../../../helpers/dcr/client-registration";
import {
  readOperatorConstraints,
  type AppPreset,
} from "../../../helpers/dcr/presets";
import type { UriViolationReason } from "../../../helpers/dcr/uri-policy";

export const SELF_SERVICE_APP_SCREEN = "self-service-app";

type Kind = "app_create" | "app_edit";

export interface SelfServiceState {
  kind: Kind;
  token_id: string;
  /** Set once a create link has registered its app. */
  completed_client_id?: string;
}

export function readSelfServiceState(
  stateDataJson: string | undefined,
): SelfServiceState | null {
  if (!stateDataJson) return null;
  try {
    const parsed: unknown = JSON.parse(stateDataJson);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.self_service)) {
      return null;
    }
    const value = parsed.self_service;
    if (
      (value.kind !== "app_create" && value.kind !== "app_edit") ||
      typeof value.token_id !== "string"
    ) {
      return null;
    }
    return {
      kind: value.kind,
      token_id: value.token_id,
      ...(typeof value.completed_client_id === "string"
        ? { completed_client_id: value.completed_client_id }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Which link a token is, or null when it can't open the setup page. */
export function ticketKind(token: ClientRegistrationToken): Kind | null {
  if (token.type === "iat" && token.source === "invite") return "app_create";
  if (token.type === "rat" && token.source === "edit_link" && token.client_id) {
    return "app_edit";
  }
  return null;
}

/** Whether the link is still usable: not revoked, expired or used up. */
export function isTicketActive(token: ClientRegistrationToken): boolean {
  if (token.revoked_at) return false;
  if (token.expires_at && Date.parse(token.expires_at) <= Date.now()) {
    return false;
  }
  if (token.single_use && token.used_at) return false;
  return true;
}

interface ActiveTicket {
  kind: Kind;
  token: ClientRegistrationToken;
  preset: AppPreset;
  /** The client an edit link manages. */
  client?: Client;
}

async function loadActiveTicket(
  context: ScreenContext,
  selfService: SelfServiceState,
): Promise<ActiveTicket | null> {
  const { ctx, tenant } = context;
  const tokens = ctx.env.data.clientRegistrationTokens;
  if (!tokens) return null;
  const token = await tokens.get(tenant.id, selfService.token_id);
  if (
    !token ||
    ticketKind(token) !== selfService.kind ||
    !isTicketActive(token)
  ) {
    return null;
  }

  if (selfService.kind === "app_create") {
    const preset = readOperatorConstraints(token.constraints).app_type;
    return preset ? { kind: "app_create", token, preset } : null;
  }

  if (!token.client_id) return null;
  const client = await ctx.env.data.clients.get(tenant.id, token.client_id);
  if (!client || client.client_metadata?.status === "deleted") return null;
  return {
    kind: "app_edit",
    token,
    preset: editPolicyAppType(client),
    client,
  };
}

async function loadSelfServiceState(
  context: ScreenContext,
): Promise<SelfServiceState | null> {
  const loginSession = await context.ctx.env.data.loginSessions.get(
    context.tenant.id,
    context.state,
  );
  return readSelfServiceState(loginSession?.state_data);
}

function t(context: ScreenContext) {
  return createTranslation(
    "self-service",
    "self-service-app",
    context.language || "en",
    context.customText,
  ).m;
}

function formAction(context: ScreenContext): string {
  return `/u2/self-service/app?state=${encodeURIComponent(context.state)}`;
}

/** The page shown for an unknown, expired, revoked or used link. */
export function invalidTicketScreen(context: ScreenContext): ScreenResult {
  const { m } = createTranslation(
    "self-service",
    "self-service-ticket-invalid",
    context.language || "en",
    context.customText,
  );
  return {
    screen: {
      name: "self-service-ticket-invalid",
      action: formAction(context),
      method: "GET",
      title: m.title(),
      description: m.description(),
      components: [],
    },
    branding: context.branding,
  };
}

export interface FormValues {
  client_name: string;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  web_origins: string[];
  logo_uri: string;
  client_uri: string;
  policy_uri: string;
  tos_uri: string;
  contact: string;
}

function valuesFromClient(client: Client): FormValues {
  const metadata = client.client_metadata ?? {};
  return {
    client_name: client.name ?? "",
    redirect_uris: client.callbacks ?? [],
    post_logout_redirect_uris: client.allowed_logout_urls ?? [],
    web_origins: client.web_origins ?? [],
    logo_uri: client.logo_uri ?? "",
    client_uri: metadata.client_uri ?? "",
    policy_uri: metadata.policy_uri ?? "",
    tos_uri: metadata.tos_uri ?? "",
    contact: (metadata.contacts ?? "").split(",")[0] ?? "",
  };
}

const EMPTY_VALUES: FormValues = {
  client_name: "",
  redirect_uris: [],
  post_logout_redirect_uris: [],
  web_origins: [],
  logo_uri: "",
  client_uri: "",
  policy_uri: "",
  tos_uri: "",
  contact: "",
};

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

/** One URL per line (whitespace-separated; URLs cannot contain spaces). */
function listField(data: Record<string, unknown>, key: string): string[] {
  return stringField(data, key).split(/\s+/).filter(Boolean);
}

export function valuesFromForm(data: Record<string, unknown>): FormValues {
  return {
    client_name: stringField(data, "client_name"),
    redirect_uris: listField(data, "redirect_uris"),
    post_logout_redirect_uris: listField(data, "post_logout_redirect_uris"),
    web_origins: listField(data, "web_origins"),
    logo_uri: stringField(data, "logo_uri"),
    client_uri: stringField(data, "client_uri"),
    policy_uri: stringField(data, "policy_uri"),
    tos_uri: stringField(data, "tos_uri"),
    contact: stringField(data, "contact"),
  };
}

function formatDate(iso: string | undefined, language: string): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: "long" }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

function appTypeLabel(m: ReturnType<typeof t>, preset: AppPreset): string {
  if (preset === "native") return m.appTypeNative();
  if (preset === "spa") return m.appTypeSpa();
  return m.appTypeRegularWeb();
}

function errorMessages(errors: Record<string, string>, field: string) {
  const text = errors[field];
  return text ? [{ text, type: "error" as const }] : undefined;
}

function formScreen(
  context: ScreenContext,
  ticket: ActiveTicket,
  values: FormValues,
  errors: Record<string, string> = {},
  messages?: UiScreen["messages"],
): ScreenResult {
  const m = t(context);
  const { preset } = ticket;
  const editing = ticket.kind === "app_edit";
  const appName = ticket.client?.name ?? "";
  const expires = formatDate(ticket.token.expires_at, context.language || "en");

  const summary = [
    `<div><strong>${escapeHtml(m.appTypeLabel())}:</strong> ${escapeHtml(appTypeLabel(m, preset))}</div>`,
    editing && ticket.client
      ? `<div><strong>${escapeHtml(m.clientIdLabel())}:</strong> <code>${escapeHtml(ticket.client.client_id)}</code></div>`
      : "",
    expires
      ? `<div style="margin-top:4px;color:#6b7280">${escapeHtml(m.expiresText({ date: expires }))}</div>`
      : "",
  ].join("");

  const components: FormNodeComponent[] = [
    {
      id: "summary",
      type: "RICH_TEXT",
      category: "BLOCK",
      visible: true,
      config: { content: summary },
      order: 0,
    },
    {
      id: "client_name",
      type: "TEXT",
      category: "FIELD",
      visible: true,
      label: m.nameLabel(),
      required: true,
      config: { default_value: values.client_name, max_length: 100 },
      order: 1,
      messages: errorMessages(errors, "client_name"),
    },
    {
      id: "redirect_uris",
      type: "TEXT",
      category: "FIELD",
      visible: true,
      label: m.callbacksLabel(),
      hint:
        preset === "native" ? m.callbacksHintNative() : m.callbacksHintWeb(),
      required: true,
      config: {
        multiline: true,
        default_value: values.redirect_uris.join("\n"),
      },
      order: 2,
      messages: errorMessages(errors, "redirect_uris"),
    },
    {
      id: "post_logout_redirect_uris",
      type: "TEXT",
      category: "FIELD",
      visible: true,
      label: m.logoutUrlsLabel(),
      required: false,
      config: {
        multiline: true,
        default_value: values.post_logout_redirect_uris.join("\n"),
      },
      order: 3,
      messages: errorMessages(errors, "post_logout_redirect_uris"),
    },
    {
      id: "web_origins",
      type: "TEXT",
      category: "FIELD",
      visible: preset !== "native",
      label: m.webOriginsLabel(),
      hint: m.webOriginsHint(),
      required: false,
      config: {
        multiline: true,
        default_value: values.web_origins.join("\n"),
      },
      order: 4,
      messages: errorMessages(errors, "web_origins"),
    },
    {
      id: "logo_uri",
      type: "URL",
      category: "FIELD",
      visible: true,
      label: m.logoUrlLabel(),
      required: false,
      config: { default_value: values.logo_uri },
      order: 5,
      messages: errorMessages(errors, "logo_uri"),
    },
    {
      id: "client_uri",
      type: "URL",
      category: "FIELD",
      visible: true,
      label: m.websiteLabel(),
      required: false,
      config: { default_value: values.client_uri },
      order: 6,
      messages: errorMessages(errors, "client_uri"),
    },
    {
      id: "policy_uri",
      type: "URL",
      category: "FIELD",
      visible: true,
      label: m.privacyLabel(),
      required: false,
      config: { default_value: values.policy_uri },
      order: 7,
      messages: errorMessages(errors, "policy_uri"),
    },
    {
      id: "tos_uri",
      type: "URL",
      category: "FIELD",
      visible: true,
      label: m.termsLabel(),
      required: false,
      config: { default_value: values.tos_uri },
      order: 8,
      messages: errorMessages(errors, "tos_uri"),
    },
    {
      id: "contact",
      type: "EMAIL",
      category: "FIELD",
      visible: true,
      label: m.contactLabel(),
      required: false,
      config: { default_value: values.contact },
      order: 9,
      messages: errorMessages(errors, "contact"),
    },
    {
      id: "submit",
      type: "NEXT_BUTTON",
      category: "BLOCK",
      visible: true,
      config: { text: editing ? m.saveButton() : m.registerButton() },
      order: 10,
    },
  ];

  return {
    screen: {
      name: SELF_SERVICE_APP_SCREEN,
      action: formAction(context),
      method: "POST",
      title: editing ? m.editTitle({ appName }) : m.title(),
      description: editing
        ? m.editDescription({ appName })
        : m.description({ tenantName: context.tenant.friendly_name }),
      components: components.filter((component) => component.visible),
      messages,
    },
    branding: context.branding,
  };
}

function doneScreen(
  context: ScreenContext,
  client: Client,
  clientSecret?: string,
): ScreenResult {
  const { m } = createTranslation(
    "self-service",
    "self-service-app-done",
    context.language || "en",
    context.customText,
  );
  const authUrl = getAuthUrl(context.ctx.env, context.ctx.var.custom_domain);
  const domain = new URL(authUrl).host;
  const row = (label: string, value: string) =>
    `<div style="margin-top:12px"><div style="font-size:13px;color:#6b7280">${escapeHtml(label)}</div><code style="word-break:break-all;user-select:all">${escapeHtml(value)}</code></div>`;

  const content = [
    row(m.clientIdLabel(), client.client_id),
    row(m.domainLabel(), domain),
    row(m.discoveryLabel(), `${authUrl}.well-known/openid-configuration`),
    clientSecret
      ? row(m.clientSecretLabel(), clientSecret) +
        `<div style="margin-top:4px;font-size:13px;color:#b45309">${escapeHtml(m.clientSecretWarning())}</div>`
      : "",
    `<div style="margin-top:16px;font-size:13px;color:#6b7280">${escapeHtml(m.pkceNote())}</div>`,
    `<div style="margin-top:8px;font-size:13px;color:#6b7280">${escapeHtml(m.editLaterText({ tenantName: context.tenant.friendly_name }))}</div>`,
  ].join("");

  return {
    screen: {
      name: "self-service-app-done",
      action: formAction(context),
      method: "GET",
      title: m.title(),
      description: m.description({ appName: client.name ?? "" }),
      components: [
        {
          id: "result",
          type: "RICH_TEXT",
          category: "BLOCK",
          visible: true,
          config: { content },
          order: 0,
        },
      ],
    },
    branding: context.branding,
  };
}

export async function selfServiceAppScreen(
  context: ScreenContext,
): Promise<ScreenResult> {
  const selfService = await loadSelfServiceState(context);
  if (!selfService) return invalidTicketScreen(context);

  // A create link that already registered its app shows the result again,
  // without the client secret (shown once, in the response to the submit).
  if (selfService.completed_client_id) {
    const client = await context.ctx.env.data.clients.get(
      context.tenant.id,
      selfService.completed_client_id,
    );
    return client ? doneScreen(context, client) : invalidTicketScreen(context);
  }

  const ticket = await loadActiveTicket(context, selfService);
  if (!ticket) return invalidTicketScreen(context);

  return formScreen(
    context,
    ticket,
    ticket.client ? valuesFromClient(ticket.client) : EMPTY_VALUES,
  );
}

const URL_FIELDS = ["logo_uri", "client_uri", "policy_uri", "tos_uri"] as const;

function toRequest(values: FormValues, preset: AppPreset): DcrRequest {
  return {
    client_name: values.client_name,
    redirect_uris: values.redirect_uris,
    post_logout_redirect_uris: values.post_logout_redirect_uris,
    ...(preset !== "native" ? { web_origins: values.web_origins } : {}),
    ...(values.logo_uri ? { logo_uri: values.logo_uri } : {}),
    ...(values.client_uri ? { client_uri: values.client_uri } : {}),
    ...(values.policy_uri ? { policy_uri: values.policy_uri } : {}),
    ...(values.tos_uri ? { tos_uri: values.tos_uri } : {}),
    ...(values.contact ? { contacts: [values.contact] } : {}),
  };
}

function uriErrorText(
  m: ReturnType<typeof t>,
  reason: UriViolationReason,
  value: string,
): string {
  switch (reason) {
    case "too_many":
      return m.uriTooMany();
    case "too_long":
      return m.uriTooLong();
    case "invalid":
      return m.uriInvalid({ value });
    case "wildcard":
      return m.uriWildcard({ value });
    case "fragment":
      return m.uriFragment({ value });
    case "userinfo":
      return m.uriUserinfo({ value });
    case "http_not_loopback":
      return m.uriHttpNotLoopback({ value });
    case "scheme_not_allowed":
      return m.uriSchemeNotAllowed({ value });
    case "custom_scheme_needs_dot":
      return m.uriCustomSchemeNeedsDot({ value });
    case "origin_only":
      return m.uriOriginOnly({ value });
    case "not_for_native":
      return m.uriNotForNative();
  }
}

const FORM_FIELD_BY_WIRE_FIELD: Record<string, string> = {
  client_name: "client_name",
  redirect_uris: "redirect_uris",
  post_logout_redirect_uris: "post_logout_redirect_uris",
  web_origins: "web_origins",
  logo_uri: "logo_uri",
  client_uri: "client_uri",
  policy_uri: "policy_uri",
  tos_uri: "tos_uri",
  contacts: "contact",
};

/** Field errors the form can show before calling the registration code. */
function validateForm(
  m: ReturnType<typeof t>,
  values: FormValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.client_name) errors.client_name = m.requiredError();
  if (values.redirect_uris.length === 0) {
    errors.redirect_uris = m.requiredError();
  }
  for (const field of URL_FIELDS) {
    const value = values[field];
    if (value && !dcrRequestSchema.shape[field].safeParse(value).success) {
      errors[field] = m.uriInvalid({ value });
    }
  }
  if (values.contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contact)) {
    errors.contact = m.invalidValueError();
  }
  return errors;
}

type PostResult = Awaited<
  ReturnType<NonNullable<ScreenDefinition["handler"]["post"]>>
>;

async function handleSelfServiceAppSubmit(
  context: ScreenContext,
  data: Record<string, unknown>,
): Promise<PostResult> {
  const { ctx, tenant } = context;
  const m = t(context);

  const selfService = await loadSelfServiceState(context);
  if (!selfService || selfService.completed_client_id) {
    return { screen: invalidTicketScreen(context) };
  }
  const ticket = await loadActiveTicket(context, selfService);
  if (!ticket) return { screen: invalidTicketScreen(context) };

  const values = valuesFromForm(data);
  const errors = validateForm(m, values);
  if (Object.keys(errors).length > 0) {
    return {
      error: m.invalidValueError(),
      screen: formScreen(context, ticket, values, errors),
    };
  }
  const request = toRequest(values, ticket.preset);

  try {
    if (ticket.kind === "app_create") {
      const registered = await registerClient(
        ctx,
        tenant,
        ticket.token,
        request,
        { issueRegistrationAccessToken: false },
      );

      const loginSession = await ctx.env.data.loginSessions.get(
        tenant.id,
        context.state,
      );
      if (loginSession) {
        const stateData: Record<string, unknown> = loginSession.state_data
          ? JSON.parse(loginSession.state_data)
          : {};
        await ctx.env.data.loginSessions.update(tenant.id, loginSession.id, {
          state_data: JSON.stringify({
            ...stateData,
            self_service: {
              ...selfService,
              completed_client_id: registered.client.client_id,
            },
          }),
        });
      }

      await logMessage(ctx, tenant.id, {
        type: LogTypes.SUCCESS_API_OPERATION,
        description: `App registered through a developer invite link (${ticket.preset})`,
        targetType: "client",
        targetId: registered.client.client_id,
      });

      return {
        screen: doneScreen(
          context,
          registered.client,
          registered.client_secret,
        ),
      };
    }

    if (!ticket.client) return { screen: invalidTicketScreen(context) };
    const { client, changed } = await updateRegisteredClient(
      ctx,
      tenant,
      ticket.client,
      request,
      { editableFieldsOnly: true },
    );

    await logMessage(ctx, tenant.id, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description:
        changed.length > 0
          ? `App updated through a developer edit link: ${changed.join(", ")}`
          : "App updated through a developer edit link",
      targetType: "client",
      targetId: client.client_id,
    });

    return {
      screen: formScreen(
        context,
        { ...ticket, client },
        valuesFromClient(client),
        {},
        [{ text: m.savedText(), type: "success" }],
      ),
    };
  } catch (err) {
    if (!(err instanceof DcrMetadataError)) throw err;
    // The link was used or revoked in another tab.
    if (err.status === 401) return { screen: invalidTicketScreen(context) };

    const formField = err.field
      ? FORM_FIELD_BY_WIRE_FIELD[err.field]
      : undefined;
    const text = err.uriViolation
      ? uriErrorText(m, err.uriViolation.reason, err.uriViolation.value ?? "")
      : m.invalidValueError();
    if (formField) {
      return {
        error: text,
        screen: formScreen(context, ticket, values, { [formField]: text }),
      };
    }
    return {
      error: m.errorText(),
      screen: formScreen(context, ticket, values, {}, [
        { text: m.errorText(), type: "error" },
      ]),
    };
  }
}

export const selfServiceAppScreenDefinition: ScreenDefinition = {
  id: SELF_SERVICE_APP_SCREEN,
  name: "Developer App Setup",
  description:
    "Register or update an OAuth app through a developer invite or edit link",
  handler: {
    get: selfServiceAppScreen,
    post: handleSelfServiceAppSubmit,
  },
};
