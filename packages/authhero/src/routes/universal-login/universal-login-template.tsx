/**
 * Universal Login Template — slot-based body markup.
 *
 * Tenants opt into custom chrome by uploading a body fragment that uses these
 * slot tokens. The default body (`DEFAULT_UNIVERSAL_LOGIN_TEMPLATE`) is
 * what's served when no custom template is stored, and is what tenants
 * should copy and edit.
 *
 * The page shell (`<!DOCTYPE>`, `<html>`, `<head>`, body styles, dark-mode
 * runtime, background tint) is fixed in code — it's not part of the tenant
 * template. This keeps tenants out of CSS/runtime authoring and limits
 * customization to layout: hide a chip by deleting its token, reorder by
 * moving them.
 *
 * Slot tokens:
 *   `{%- auth0:widget -%}`             — widget container (required)
 *   `{%- authhero:logo -%}`            — logo chip (top-left)
 *   `{%- authhero:settings -%}`        — settings chip (top-right), wraps the
 *                                        dark-mode toggle + language picker
 *   `{%- authhero:dark-mode-toggle -%}`— dark-mode button only
 *   `{%- authhero:language-picker -%}` — language picker only
 *   `{%- authhero:powered-by -%}`      — powered-by chip (bottom-left)
 *   `{%- authhero:legal -%}`           — legal/terms chip (bottom-right)
 */

import {
  LogoChip,
  SettingsChip,
  DarkModeToggle,
  LanguagePicker,
  PoweredByChip,
  LegalChip,
  type DarkModePreference,
} from "./u2-widget-page";

export const REQUIRED_SLOT = "{%- auth0:widget -%}";

/**
 * Canonical default body. Mirrors the layout the JSX `WidgetPage` emits.
 * Tenants who want to hide a chip should copy this, delete a slot, and PUT
 * it back via `PUT /api/v2/branding/templates/universal-login`.
 */
export const DEFAULT_UNIVERSAL_LOGIN_TEMPLATE = `{%- auth0:widget -%}
{%- authhero:logo -%}
{%- authhero:settings -%}
{%- authhero:powered-by -%}
{%- authhero:legal -%}
`;

export type TemplateSlotOptions = {
  widgetHtml: string;
  logoUrl?: string | null;
  clientName: string;
  darkMode: DarkModePreference;
  language?: string;
  availableLanguages?: string[];
  poweredBy?: {
    url: string;
    href?: string;
    alt?: string;
    height?: number;
  };
  termsAndConditionsUrl?: string;
};

function widgetContainerHtml(
  widgetHtml: string,
  screenId: string,
  containerStyle?: string,
): string {
  const styleAttr = containerStyle ? ` style="${containerStyle}"` : "";
  return `<div class="widget-container" data-authhero-widget-container data-screen="${escapeAttr(
    screenId,
  )}"${styleAttr}>${widgetHtml}</div>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Expand slot tokens in a template body. Unknown tokens are left in place
 * (so tenants can spot typos in their templates).
 */
export function applyUniversalLoginTemplate(
  template: string,
  opts: TemplateSlotOptions & { screenId: string; widgetContainerStyle?: string },
): string {
  const settingsChip = (
    <SettingsChip
      darkMode={opts.darkMode}
      language={opts.language}
      availableLanguages={opts.availableLanguages}
    />
  ).toString();

  const fragments: Record<string, string> = {
    "{%- auth0:widget -%}": widgetContainerHtml(
      opts.widgetHtml,
      opts.screenId,
      opts.widgetContainerStyle,
    ),
    "{%- authhero:logo -%}": (
      <LogoChip logoUrl={opts.logoUrl} clientName={opts.clientName} />
    ).toString(),
    "{%- authhero:settings -%}": settingsChip,
    "{%- authhero:dark-mode-toggle -%}": (
      <DarkModeToggle darkMode={opts.darkMode} />
    ).toString(),
    "{%- authhero:language-picker -%}": opts.availableLanguages
      ? (
          <LanguagePicker
            language={opts.language}
            availableLanguages={opts.availableLanguages}
          />
        ).toString()
      : "",
    "{%- authhero:powered-by -%}": opts.poweredBy
      ? (
          <PoweredByChip
            url={opts.poweredBy.url}
            href={opts.poweredBy.href}
            alt={opts.poweredBy.alt}
            height={opts.poweredBy.height}
          />
        ).toString()
      : "",
    "{%- authhero:legal -%}": opts.termsAndConditionsUrl
      ? (
          <LegalChip
            termsAndConditionsUrl={opts.termsAndConditionsUrl}
            language={opts.language}
          />
        ).toString()
      : "",
  };

  let result = template;
  for (const [token, value] of Object.entries(fragments)) {
    result = result.split(token).join(value);
  }
  return result;
}
