import { useEffect, useRef, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Wand2,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  TextInput,
  NumberInput,
  BooleanInput,
  SelectInput,
} from "@/components/admin";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ColorInput } from "./color-input";
import { AssetUrlInput } from "./asset-url-input";
import { ThemesRawEditor } from "./themes-raw";
import {
  CORE_COLOR_KEYS,
  DEFAULT_DARK_PAGE_BACKGROUND,
  contrastWarnings,
  deriveDependentColors,
  generateDarkFromLight,
  completeLightColors,
  isHexColor,
  type ThemeColors,
} from "./theme-colors";

const keepEmptyString = (v: string | null | undefined) => v ?? "";

type ColorKey = string;

const colorLabels: Record<ColorKey, string> = {
  primary_button: "Primary color (buttons)",
  widget_background: "Widget background",
  body_text: "Text",
  links_focused_components: "Links",
  widget_border: "Border",
  error: "Error",
  primary_button_label: "Primary Button Label",
  secondary_button_border: "Secondary Button Border",
  secondary_button_label: "Secondary Button Label",
  base_focus_color: "Base Focus Color",
  base_hover_color: "Base Hover Color",
  header: "Header",
  icons: "Icons",
  input_background: "Input Background",
  input_border: "Input Border",
  input_filled_text: "Input Filled Text",
  input_labels_placeholders: "Input Labels/Placeholders",
  success: "Success",
};

const coreKeys: ColorKey[] = [...CORE_COLOR_KEYS];
const advancedKeys: ColorKey[] = Object.keys(colorLabels).filter(
  (k) => !coreKeys.includes(k),
);

type Scheme = "light" | "dark";

const fontSections: { key: string; label: string }[] = [
  { key: "body_text", label: "Body Text" },
  { key: "buttons_text", label: "Buttons Text" },
  { key: "input_labels", label: "Input Labels" },
  { key: "links", label: "Links" },
  { key: "subtitle", label: "Subtitle" },
  { key: "title", label: "Title" },
];

/** Where a colour lives for the active scheme. */
const colorSource = (scheme: Scheme, key: ColorKey) =>
  scheme === "dark" ? `themes.colors_dark.${key}` : `themes.colors.${key}`;

function ColorField({ scheme, k }: { scheme: Scheme; k: ColorKey }) {
  const dark = scheme === "dark";
  return (
    <ColorInput
      source={colorSource(scheme, k)}
      label={colorLabels[k]}
      clearable={dark}
      emptyPlaceholder={dark ? "Same as light / derived" : undefined}
    />
  );
}

/**
 * In the simple view only the core colours are edited. While a dependent
 * colour (button label, focus, hover, header, input colours ...) still holds
 * what the previous core would have derived, keep it in step with the core.
 * A dependent the user has set to something else is left alone.
 */
function useFollowCore() {
  const { getValues, setValue } = useFormContext();
  const values = useWatch({
    name: coreKeys.map((k) => `themes.colors.${k}`),
  }) as (string | undefined)[];
  const prev = useRef<ThemeColors | null>(null);

  useEffect(() => {
    const current: ThemeColors = {};
    coreKeys.forEach((k, i) => (current[k] = values?.[i] || undefined));
    // Wait until every set value is a complete colour; a half-typed hex
    // would otherwise derive garbage.
    if (Object.values(current).some((v) => v && !isHexColor(v))) return;
    const before = prev.current;
    prev.current = current;
    if (!before) return;
    if (coreKeys.every((k) => before[k] === current[k])) return;
    const was = deriveDependentColors(before);
    const next = deriveDependentColors(current);
    for (const [k, derived] of Object.entries(next)) {
      const path = `themes.colors.${k}`;
      const existing = getValues(path) as string | undefined;
      const follows =
        !existing || existing.toLowerCase() === was[k]?.toLowerCase();
      if (follows && existing !== derived) {
        setValue(path, derived, { shouldDirty: true });
      }
    }
  }, [values, getValues, setValue]);
}

function ContrastWarnings({ scheme }: { scheme: Scheme }) {
  const light = useWatch({ name: "themes.colors" }) as ThemeColors | undefined;
  const dark = useWatch({ name: "themes.colors_dark" }) as
    | ThemeColors
    | undefined;
  const palette: ThemeColors =
    scheme === "light"
      ? completeLightColors(light)
      : {
          ...generateDarkFromLight(light ?? {}),
          ...Object.fromEntries(
            Object.entries(dark ?? {}).filter(([, v]) => !!v),
          ),
        };
  const warnings = contrastWarnings(palette);
  if (!warnings.length) return null;
  return (
    <Alert>
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>
        <div className="font-medium">
          Low contrast in the {scheme} palette (WCAG)
        </div>
        <ul className="mt-1 list-disc pl-5">
          {warnings.map((w) => (
            <li key={w.label}>
              {w.label}: {w.ratio.toFixed(1)}:1 (needs {w.min}:1)
            </li>
          ))}
        </ul>
        {scheme === "dark" && (
          <p className="mt-1 text-xs text-muted-foreground">
            Fields left on "same as light / derived" are checked against the
            palette the generator would produce.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function GenerateDarkButton() {
  const { getValues, setValue } = useFormContext();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        const light = (getValues("themes.colors") ?? {}) as ThemeColors;
        const dark = generateDarkFromLight(light);
        for (const [k, v] of Object.entries(dark)) {
          setValue(`themes.colors_dark.${k}`, v, { shouldDirty: true });
        }
        if (!getValues("themes.page_background.background_color_dark")) {
          setValue(
            "themes.page_background.background_color_dark",
            DEFAULT_DARK_PAGE_BACKGROUND,
            { shouldDirty: true },
          );
        }
      }}
    >
      <Wand2 className="mr-2 h-4 w-4" />
      Generate dark from light
    </Button>
  );
}

function ThemesFormFields() {
  const [scheme, setScheme] = useState<Scheme>("light");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useFollowCore();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <TextInput source="themes.displayName" label="Display Name" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          value={scheme}
          onValueChange={(v) => {
            if (v === "light" || v === "dark") setScheme(v);
          }}
          variant="outline"
          size="sm"
          aria-label="Color scheme being edited"
        >
          <ToggleGroupItem value="light">Light</ToggleGroupItem>
          <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
        </ToggleGroup>
        {scheme === "dark" && <GenerateDarkButton />}
      </div>

      {scheme === "dark" && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            Dark values are optional. A field left empty falls back to a palette
            derived from the light value, so you only set what should differ.
            Dark overrides are an AuthHero extension and are ignored by Auth0.
          </AlertDescription>
        </Alert>
      )}

      <ContrastWarnings scheme={scheme} />

      <section className="flex flex-col gap-4">
        <h4 className="text-base font-semibold">
          Colors{scheme === "dark" ? " (dark)" : ""}
        </h4>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {coreKeys.map((k) => (
            <ColorField key={`${scheme}-${k}`} scheme={scheme} k={k} />
          ))}
        </div>
        {scheme === "light" && (
          <p className="text-xs text-muted-foreground">
            Button label, focus, hover, header and input colors follow these
            unless you set them under Advanced.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h4 className="text-base font-semibold">Logo and page background</h4>
        {scheme === "light" ? (
          <>
            <AssetUrlInput
              source="themes.widget.logo_url"
              label="Logo URL"
              kind="logo"
              parse={keepEmptyString}
            />
            <ColorInput
              source="themes.page_background.background_color"
              label="Background Color"
            />
            <AssetUrlInput
              source="themes.page_background.background_image_url"
              label="Background Image URL"
              kind="background"
              parse={keepEmptyString}
            />
          </>
        ) : (
          <>
            <AssetUrlInput
              source="themes.widget.logo_url_dark"
              label="Logo URL (dark)"
              kind="logo"
              parse={keepEmptyString}
            />
            <ColorInput
              source="themes.page_background.background_color_dark"
              label="Background Color (dark)"
              clearable
              emptyPlaceholder="Same as light"
            />
            <AssetUrlInput
              source="themes.page_background.background_image_url_dark"
              label="Background Image URL (dark)"
              kind="background"
              parse={keepEmptyString}
            />
            <p className="text-xs text-muted-foreground">
              Leave a field empty to use the light value.
            </p>
          </>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <button
          type="button"
          className="flex items-center gap-2 text-left text-base font-semibold"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          aria-controls="theme-advanced"
        >
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Advanced
        </button>
        {/* Kept mounted so collapsed values stay in the form. */}
        <div
          id="theme-advanced"
          className={advancedOpen ? "flex flex-col gap-6" : "hidden"}
        >
          <section className="flex flex-col gap-4">
            <h4 className="text-sm font-semibold">
              More colors{scheme === "dark" ? " (dark)" : ""}
            </h4>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {advancedKeys.map((k) => (
                <ColorField key={`${scheme}-${k}`} scheme={scheme} k={k} />
              ))}
            </div>
            {scheme === "light" && (
              <SelectInput
                source="themes.colors.captcha_widget_theme"
                label="Captcha Widget Theme"
                choices={[
                  { id: "auto", name: "Auto" },
                  { id: "dark", name: "Dark" },
                  { id: "light", name: "Light" },
                ]}
              />
            )}
          </section>

          {scheme === "light" && (
            <>
              <section className="flex flex-col gap-4">
                <h4 className="text-base font-semibold">Borders</h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <NumberInput
                    source="themes.borders.button_border_radius"
                    label="Button Border Radius"
                  />
                  <NumberInput
                    source="themes.borders.button_border_weight"
                    label="Button Border Weight"
                  />
                  <NumberInput
                    source="themes.borders.input_border_radius"
                    label="Input Border Radius"
                  />
                  <NumberInput
                    source="themes.borders.input_border_weight"
                    label="Input Border Weight"
                  />
                  <NumberInput
                    source="themes.borders.widget_border_weight"
                    label="Widget Border Weight"
                  />
                  <NumberInput
                    source="themes.borders.widget_corner_radius"
                    label="Widget Corner Radius"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <SelectInput
                    source="themes.borders.buttons_style"
                    label="Buttons Style"
                    choices={[
                      { id: "pill", name: "Pill" },
                      { id: "rounded", name: "Rounded" },
                      { id: "sharp", name: "Sharp" },
                    ]}
                  />
                  <SelectInput
                    source="themes.borders.inputs_style"
                    label="Inputs Style"
                    choices={[
                      { id: "pill", name: "Pill" },
                      { id: "rounded", name: "Rounded" },
                      { id: "sharp", name: "Sharp" },
                    ]}
                  />
                </div>
                <BooleanInput
                  source="themes.borders.show_widget_shadow"
                  label="Show Widget Shadow"
                />
              </section>

              <section className="flex flex-col gap-4">
                <h4 className="text-base font-semibold">Fonts</h4>
                <AssetUrlInput
                  source="themes.fonts.font_url"
                  label="Font URL"
                  kind="font"
                  parse={keepEmptyString}
                />
                <NumberInput
                  source="themes.fonts.reference_text_size"
                  label="Reference Text Size"
                />
                {fontSections.map(({ key, label }) => (
                  <div key={key} className="flex flex-col gap-2">
                    <div className="text-sm font-medium">{label}</div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <BooleanInput
                        source={`themes.fonts.${key}.bold`}
                        label="Bold"
                      />
                      <NumberInput
                        source={`themes.fonts.${key}.size`}
                        label="Size"
                      />
                    </div>
                  </div>
                ))}
                <SelectInput
                  source="themes.fonts.links_style"
                  label="Links Style"
                  choices={[
                    { id: "normal", name: "Normal" },
                    { id: "underlined", name: "Underlined" },
                  ]}
                />
              </section>

              <section className="flex flex-col gap-4">
                <h4 className="text-base font-semibold">Layout</h4>
                <SelectInput
                  source="themes.page_background.page_layout"
                  label="Page Layout"
                  choices={[
                    { id: "center", name: "Center" },
                    { id: "left", name: "Left" },
                    { id: "right", name: "Right" },
                  ]}
                />
                <SelectInput
                  source="themes.page_background.logo_placement"
                  label="Logo Placement"
                  helperText="Where the tenant logo renders on the page. Chip suppresses the widget's internal logo."
                  choices={[
                    { id: "widget", name: "Inside widget (default)" },
                    { id: "chip", name: "Floating chip (top-left)" },
                    { id: "none", name: "None" },
                  ]}
                />
              </section>

              <section className="flex flex-col gap-4">
                <h4 className="text-base font-semibold">Widget</h4>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <SelectInput
                    source="themes.widget.header_text_alignment"
                    label="Header Text Alignment"
                    choices={[
                      { id: "center", name: "Center" },
                      { id: "left", name: "Left" },
                      { id: "right", name: "Right" },
                    ]}
                  />
                  <NumberInput
                    source="themes.widget.logo_height"
                    label="Logo Height"
                  />
                  <SelectInput
                    source="themes.widget.logo_position"
                    label="Logo Position"
                    choices={[
                      { id: "center", name: "Center" },
                      { id: "left", name: "Left" },
                      { id: "none", name: "None" },
                      { id: "right", name: "Right" },
                    ]}
                  />
                  <SelectInput
                    source="themes.widget.social_buttons_layout"
                    label="Social Buttons Layout"
                    choices={[
                      { id: "bottom", name: "Bottom" },
                      { id: "top", name: "Top" },
                    ]}
                  />
                </div>
              </section>
            </>
          )}
          {scheme === "dark" && (
            <p className="text-xs text-muted-foreground">
              Borders, fonts and layout are shared by both schemes. Switch to
              Light to edit them.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export function ThemesTab() {
  const [view, setView] = useState<"form" | "raw">("form");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">Theme Configuration</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure the visual theme for your authentication pages. These
            settings control colors, fonts, and layout.
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(value) => {
            if (value === "form" || value === "raw") setView(value);
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="form">Form</ToggleGroupItem>
          <ToggleGroupItem value="raw">JSON</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          The theme is the source of truth for the login page. Its logo, page
          background, primary color and fonts win over the matching values on
          the Style tab, which are only used for fields the theme leaves empty.
          Favicon and "powered by" logo are only set on the Style tab.
        </AlertDescription>
      </Alert>

      {/* Keep the form fields mounted so values persist when toggling views. */}
      <div className={view === "form" ? undefined : "hidden"}>
        <ThemesFormFields />
      </div>
      {view === "raw" && <ThemesRawEditor />}
    </div>
  );
}
