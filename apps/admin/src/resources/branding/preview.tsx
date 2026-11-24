import { useEffect, useRef, useState } from "react";
import { useWatch } from "react-hook-form";
import { useNotify } from "ra-core";
import { ExternalLink, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTenantId } from "@/TenantContext";
import {
  PREVIEW_SCREENS,
  fetchPreviewHtml,
  getApiUrl,
  openFullPreview,
  pruneBrandingOverride,
  pruneNullish,
  withApiBase,
  type PreviewColorScheme,
  type PreviewScreenId,
} from "./previewClient";

const WIDGET_SCRIPT_ATTR = "data-authhero-widget";

/**
 * Load the widget from the auth server the admin is pointed at (the same
 * `/u/widget` build the login pages use), so the preview cannot drift from the
 * server. Added once per page.
 */
function ensureWidgetScript(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`script[${WIDGET_SCRIPT_ATTR}]`)) return;
  const s = document.createElement("script");
  s.type = "module";
  s.src = `${getApiUrl()}/u/widget/authhero-widget.esm.js`;
  s.setAttribute(WIDGET_SCRIPT_ATTR, "true");
  document.head.appendChild(s);
}

interface FormComponent {
  id: string;
  type: string;
  category: "FIELD" | "BLOCK" | "WIDGET";
  visible: boolean;
  label?: string;
  config?: Record<string, unknown>;
  required?: boolean;
  sensitive?: boolean;
  order: number;
  messages?: Array<{ text: string; type: "error" | "success" }>;
}

interface ScreenLink {
  id?: string;
  text: string;
  linkText?: string;
  href: string;
}

interface UiScreen {
  action: string;
  method: string;
  title?: string;
  description?: string;
  components: FormComponent[];
  links?: ScreenLink[];
  messages?: Array<{ text: string; type: "error" | "success" }>;
  /** Raw HTML rendered into the prompt's insertion points. */
  partials?: Partial<Record<string, string>>;
}

const sampleScreen: UiScreen = {
  action: "#",
  method: "POST",
  title: "Welcome",
  description: "Sign in to continue",
  components: [
    {
      id: "social-buttons",
      type: "SOCIAL",
      category: "FIELD",
      visible: true,
      config: { providers: ["google-oauth2"] },
      order: 0,
    },
    {
      id: "divider",
      type: "DIVIDER",
      category: "BLOCK",
      visible: true,
      order: 1,
    },
    {
      id: "username",
      type: "EMAIL",
      category: "FIELD",
      visible: true,
      label: "Email address",
      config: { placeholder: "name@example.com" },
      required: true,
      order: 2,
    },
    {
      id: "submit",
      type: "NEXT_BUTTON",
      category: "BLOCK",
      visible: true,
      config: { text: "Continue" },
      order: 3,
    },
  ],
  links: [
    {
      id: "signup",
      text: "Don't have an account?",
      linkText: "Sign up",
      href: "#",
    },
  ],
};

/** Client-side samples, used by the prompt partials editor. */
export const screenConfigs: Record<"login" | "signup" | "password", UiScreen> =
  {
    login: sampleScreen,
    signup: {
      ...sampleScreen,
      title: "Create account",
      description: "Sign up to get started",
      components: [
        ...sampleScreen.components.slice(0, 3),
        {
          id: "password",
          type: "PASSWORD",
          category: "FIELD",
          visible: true,
          label: "Password",
          config: { placeholder: "Enter your password" },
          required: true,
          sensitive: true,
          order: 3,
        },
        {
          id: "submit",
          type: "NEXT_BUTTON",
          category: "BLOCK",
          visible: true,
          config: { text: "Sign up" },
          order: 4,
        },
      ],
      links: [
        {
          id: "login",
          text: "Already have an account?",
          linkText: "Sign in",
          href: "#",
        },
      ],
    },
    password: {
      action: "#",
      method: "POST",
      title: "Enter your password",
      description: "Signing in as <strong>user@example.com</strong>",
      components: [
        {
          id: "password",
          type: "PASSWORD",
          category: "FIELD",
          visible: true,
          label: "Password",
          config: { placeholder: "Enter your password" },
          required: true,
          sensitive: true,
          order: 0,
        },
        {
          id: "submit",
          type: "NEXT_BUTTON",
          category: "BLOCK",
          visible: true,
          config: { text: "Continue" },
          order: 1,
        },
      ],
      links: [
        {
          id: "forgot",
          text: "Forgot your password?",
          linkText: "Reset it",
          href: "#",
        },
      ],
    },
  };

interface PageBackgroundObject {
  type?: string;
  start?: string;
  end?: string;
  angle_deg?: number;
}

export interface WidgetBranding {
  colors?: {
    primary?: string;
    page_background?: PageBackgroundObject | string;
  };
  logo_url?: string;
  favicon_url?: string;
  font?: { url?: string };
}

export interface WidgetTheme {
  borders?: Record<string, unknown>;
  colors?: Record<string, unknown>;
  fonts?: Record<string, unknown>;
  page_background?: {
    background_color?: string;
    background_image_url?: string;
    page_layout?: "center" | "left" | "right";
    logo_placement?: "widget" | "chip" | "none";
  };
  widget?: Record<string, unknown>;
}

interface WidgetElement extends HTMLElement {
  screen?: UiScreen;
  branding?: WidgetBranding;
  theme?: WidgetTheme;
}

function isPageBackgroundObject(v: unknown): v is PageBackgroundObject {
  return typeof v === "object" && v !== null;
}

const SCREEN_LABELS: Record<PreviewScreenId, string> = {
  login: "Login",
  password: "Password",
  signup: "Signup",
  otp: "OTP",
  mfa: "MFA",
  consent: "Consent",
  error: "Error",
};

const PREVIEW_DEBOUNCE_MS = 400;

interface BrandingPreviewProps {
  /**
   * Controlled colour scheme. Pass this together with `onColorSchemeChange`
   * to drive the preview from elsewhere, e.g. the light/dark editing switch of
   * the theme form. Omit both to let the preview manage its own toggle.
   */
  colorScheme?: PreviewColorScheme;
  onColorSchemeChange?: (scheme: PreviewColorScheme) => void;
}

export function BrandingPreview({
  colorScheme: controlledScheme,
  onColorSchemeChange,
}: BrandingPreviewProps = {}) {
  const [previewScreen, setPreviewScreen] = useState<PreviewScreenId>("login");
  const [internalScheme, setInternalScheme] =
    useState<PreviewColorScheme>("light");
  const colorScheme = controlledScheme ?? internalScheme;
  const setColorScheme = (scheme: PreviewColorScheme) => {
    if (controlledScheme === undefined) setInternalScheme(scheme);
    onColorSchemeChange?.(scheme);
  };
  const tenantId = useTenantId() ?? "";
  const notify = useNotify();

  const colors = useWatch({ name: "colors" }) as
    | { primary?: string; page_background?: PageBackgroundObject | string }
    | undefined;
  const logoUrl = useWatch({ name: "logo_url" }) as string | undefined;
  const faviconUrl = useWatch({ name: "favicon_url" }) as string | undefined;
  const font = useWatch({ name: "font" }) as { url?: string } | undefined;
  const themes = useWatch({ name: "themes" }) as WidgetTheme | undefined;

  const branding = buildPreviewBranding({ colors, logoUrl, faviconUrl, font });
  const theme = buildPreviewTheme(themes);

  const handleOpenFull = async () => {
    if (!tenantId) return;
    try {
      await openFullPreview({
        tenantId,
        screen: previewScreen,
        branding,
        theme,
        colorScheme,
      });
    } catch {
      notify("Failed to open preview", { type: "error" });
    }
  };

  return (
    <div className="flex h-full flex-col gap-2 rounded-lg bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handleOpenFull}
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          title="Open the full-size login page in a new tab"
        >
          Preview
          <ExternalLink className="size-3" />
        </Button>
        <div
          className="flex gap-1"
          role="group"
          aria-label="Preview colour scheme"
        >
          {(["light", "dark"] as PreviewColorScheme[]).map((scheme) => (
            <Button
              key={scheme}
              type="button"
              size="sm"
              variant={colorScheme === scheme ? "default" : "outline"}
              aria-pressed={colorScheme === scheme}
              onClick={() => setColorScheme(scheme)}
              className="h-7 gap-1 px-2 text-xs capitalize"
            >
              {scheme === "light" ? (
                <Sun className="size-3" />
              ) : (
                <Moon className="size-3" />
              )}
              {scheme}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {PREVIEW_SCREENS.map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={previewScreen === s ? "default" : "outline"}
            onClick={() => setPreviewScreen(s)}
            className="h-7 px-2 text-xs"
          >
            {SCREEN_LABELS[s]}
          </Button>
        ))}
      </div>

      <ServerPreviewFrame
        tenantId={tenantId}
        screen={previewScreen}
        colorScheme={colorScheme}
        branding={branding}
        theme={theme}
        className="flex-1"
      />
    </div>
  );
}

/** Assemble the branding overrides sent to the preview endpoint. */
export function buildPreviewBranding(input: {
  colors?: {
    primary?: string;
    page_background?: PageBackgroundObject | string;
  };
  logoUrl?: string;
  faviconUrl?: string;
  font?: { url?: string };
}): WidgetBranding {
  const { colors, logoUrl, faviconUrl, font } = input;
  return {
    colors: {
      primary: colors?.primary,
      page_background:
        typeof colors?.page_background === "string"
          ? { type: "solid", start: colors.page_background }
          : colors?.page_background,
    },
    logo_url: logoUrl,
    favicon_url: faviconUrl,
    font,
  };
}

/** Assemble the theme overrides sent to the preview endpoint. */
export function buildPreviewTheme(
  themes: WidgetTheme | undefined,
): WidgetTheme | undefined {
  if (!themes) return undefined;
  // Pass the whole theme through, so the dark fields (`colors_dark`,
  // `*_dark`) and anything added later reach the server renderer unchanged.
  return themes;
}

/**
 * Renders the real Universal Login page through the server's preview endpoint
 * in a sandboxed iframe. Template, dark scheme, background image and widget
 * build all come from the server, exactly as on the live login page. Requests
 * are debounced, and a stale response never replaces a newer one.
 */
function ServerPreviewFrame({
  tenantId,
  screen,
  colorScheme,
  branding,
  theme,
  className = "",
}: {
  tenantId: string;
  screen: PreviewScreenId;
  colorScheme: PreviewColorScheme;
  branding: WidgetBranding;
  theme?: WidgetTheme;
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Serialise so the effect only re-runs when the content actually changes
  // (the form hands us fresh objects on every render).
  const payload = JSON.stringify({
    branding: pruneBrandingOverride(branding),
    theme: pruneNullish(theme),
  });

  useEffect(() => {
    if (!tenantId) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const parsed = JSON.parse(payload) as {
          branding?: unknown;
          theme?: unknown;
        };
        const rendered = await fetchPreviewHtml({
          tenantId,
          screen,
          colorScheme,
          branding: parsed.branding,
          theme: parsed.theme,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setHtml(withApiBase(rendered, getApiUrl()));
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Branding preview failed", err);
        const status = (err as { httpStatus?: number })?.httpStatus;
        const message = err instanceof Error ? err.message : String(err);
        setError(status ? `${status}: ${message}` : message);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tenantId, screen, colorScheme, payload]);

  return (
    <div
      className={`relative overflow-hidden rounded-md bg-background ${className}`}
    >
      {html !== null && (
        <iframe
          title="Universal Login preview"
          // No allow-same-origin: tenant template code runs in an opaque
          // origin and cannot reach the admin's storage or APIs. Forms and
          // popups stay blocked, the preview is for looking only.
          sandbox="allow-scripts"
          srcDoc={html}
          className="size-full border-0"
        />
      )}
      {error && (
        <div className="absolute inset-x-0 top-0 bg-destructive/10 p-2 text-center text-xs text-destructive">
          Could not render the preview ({error}).
          {html !== null && " Showing the last version."}
        </div>
      )}
      {html === null && !error && (
        <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
          Loading preview…
        </div>
      )}
    </div>
  );
}

/**
 * Renders `<authhero-widget>` on the tenant's page background. Shared by the
 * branding and prompt partials editors.
 */
export function WidgetPreview({
  screen,
  branding,
  theme,
  className = "",
}: {
  screen: UiScreen;
  branding: WidgetBranding;
  theme?: WidgetTheme;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const getBackgroundStyle = (): React.CSSProperties => {
    if (theme?.page_background?.background_color) {
      return { background: theme.page_background.background_color };
    }
    const bg = branding.colors?.page_background;
    if (!bg) return { background: "#f5f5f5" };
    if (typeof bg === "string") return { background: bg };
    if (
      isPageBackgroundObject(bg) &&
      bg.type === "linear-gradient" &&
      bg.start &&
      bg.end
    ) {
      const angle = bg.angle_deg ?? 180;
      return {
        background: `linear-gradient(${angle}deg, ${bg.start}, ${bg.end})`,
      };
    }
    if (isPageBackgroundObject(bg) && bg.start) return { background: bg.start };
    return { background: "#f5f5f5" };
  };

  // Create the element and hand it its data as properties. Nothing is ever
  // serialised into HTML, so no value can break out of an attribute.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureWidgetScript();
    const widget = document.createElement("authhero-widget") as WidgetElement;
    widget.screen = screen;
    widget.branding = branding;
    if (theme) widget.theme = theme;
    container.replaceChildren(widget);
    return () => {
      widget.remove();
    };
  }, [branding, theme, screen]);

  return (
    <div
      className={`flex items-center justify-center overflow-hidden rounded-md ${className}`}
      style={getBackgroundStyle()}
    >
      <div ref={containerRef} />
    </div>
  );
}
