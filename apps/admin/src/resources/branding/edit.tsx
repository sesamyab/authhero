import { useState } from "react";
import { useWatch } from "react-hook-form";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Edit, SelectInput, SimpleForm, TextInput } from "@/components/admin";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/ui/url-tabs";
import { ColorInput } from "./color-input";
import { AssetUrlInput } from "./asset-url-input";
import { ThemesTab } from "./themes-tab";
import { transformBranding } from "./transform";
import { UniversalLoginTab } from "./universal-login-tab";
import { BrandingPreview } from "./preview";
import { RawJsonTab } from "@/common/RawJsonTab";

const keepEmptyString = (v: string | null | undefined) => v ?? "";

function PageBackgroundFields() {
  const type = useWatch({ name: "colors.page_background.type" }) as
    | string
    | undefined;
  const isGradient = type === "linear-gradient" || type === "gradient";

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="text-sm font-medium">Page Background</div>
      <SelectInput
        source="colors.page_background.type"
        label="Type"
        choices={[
          { id: "solid", name: "Solid" },
          { id: "linear-gradient", name: "Gradient" },
        ]}
      />
      <ColorInput
        source="colors.page_background.start"
        label={isGradient ? "Start color" : "Color"}
      />
      {isGradient && (
        <>
          <ColorInput source="colors.page_background.end" label="End color" />
          <TextInput
            source="colors.page_background.angle_deg"
            label="Gradient angle (deg)"
            type="number"
          />
        </>
      )}
    </div>
  );
}

function StyleTab() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <ColorInput source="colors.primary" label="Primary color" />
      <PageBackgroundFields />
      <div className="flex flex-col gap-4 rounded-md border p-3">
        <div className="text-sm font-medium">Assets</div>
        <p className="text-xs text-muted-foreground">
          When a theme exists it wins: the logo and page background below are
          only used where the Themes tab leaves them empty. Edit light and dark
          variants of the logo and background on the Themes tab.
        </p>
        <AssetUrlInput
          source="favicon_url"
          label="Favicon URL"
          kind="favicon"
          parse={keepEmptyString}
        />
        <AssetUrlInput
          source="favicon_url_dark"
          label="Favicon URL (dark)"
          kind="favicon"
          parse={keepEmptyString}
        />
        <AssetUrlInput
          source="logo_url"
          label="Logo URL"
          kind="logo"
          parse={keepEmptyString}
        />
        <AssetUrlInput
          source="powered_by_logo_url"
          label="Powered-by logo URL"
          kind="powered_by_logo"
          parse={keepEmptyString}
        />
        <AssetUrlInput
          source="font.url"
          label="Font URL"
          kind="font"
          parse={keepEmptyString}
        />
      </div>
      <SelectInput
        source="dark_mode"
        label="Dark mode"
        emptyText="Auto (follow system)"
        helperText="Default color scheme for the universal login page. When unset the server uses Auto. The per-user ah-dark-mode cookie still overrides this at runtime."
        choices={[
          { id: "auto", name: "Auto (follow system)" },
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ]}
      />
    </div>
  );
}

/** The preview plus a hint when the dark preview reuses the light logo. */
function PreviewColumn({
  scheme,
  onSchemeChange,
}: {
  scheme: "light" | "dark";
  onSchemeChange: (s: "light" | "dark") => void;
}) {
  const [themeLogo, logoDark, brandingLogo] = useWatch({
    name: ["themes.widget.logo_url", "themes.widget.logo_url_dark", "logo_url"],
  }) as (string | undefined)[];
  const reusesLightLogo =
    scheme === "dark" && !logoDark && !!(themeLogo || brandingLogo);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1">
        <BrandingPreview
          colorScheme={scheme}
          onColorSchemeChange={onSchemeChange}
        />
      </div>
      {reusesLightLogo && (
        <p role="note" className="text-xs text-muted-foreground">
          The dark preview uses the light logo. A dark logo is hard to see on a
          dark card; set one under Themes &gt; Dark &gt; Logo URL (dark).
        </p>
      )}
    </div>
  );
}

function BrandingFormContent() {
  // One scheme for both: the theme form edits it, the preview shows it.
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  // Below `lg` there is no room for the side column, so the preview is
  // stacked under the tabs behind a toggle instead.
  const [showStackedPreview, setShowStackedPreview] = useState(false);
  return (
    <div className="flex w-full gap-6 [&_input:not([type=color])]:bg-white dark:[&_input:not([type=color])]:bg-input/30 [&_button[data-slot=select-trigger]]:bg-white dark:[&_button[data-slot=select-trigger]]:bg-input/30 [&_div.rounded-md.border.p-3]:bg-white dark:[&_div.rounded-md.border.p-3]:bg-transparent dark:[&_.text-muted-foreground]:text-foreground/80 dark:[&_div.border]:border-foreground/25 dark:[&_input]:border-foreground/30 dark:[&_button[data-slot=select-trigger]]:border-foreground/30 [&_h3]:text-foreground [&_h4]:text-foreground [&_label]:text-foreground">
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-col gap-3 lg:hidden">
          <Button
            type="button"
            variant="outline"
            className="self-start"
            aria-expanded={showStackedPreview}
            onClick={() => setShowStackedPreview((v) => !v)}
          >
            {showStackedPreview ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
            {showStackedPreview ? "Hide preview" : "Show preview"}
          </Button>
          {showStackedPreview && (
            <div className="h-[560px] w-full max-w-[420px]">
              <PreviewColumn scheme={scheme} onSchemeChange={setScheme} />
            </div>
          )}
        </div>
        <UrlTabs defaultValue="style">
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            <TabsTrigger value="style">Style</TabsTrigger>
            <TabsTrigger value="themes">Themes</TabsTrigger>
            <TabsTrigger value="universal-login">Universal Login</TabsTrigger>
            <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="style" className="mt-4">
            <StyleTab />
          </TabsContent>
          <TabsContent value="themes" className="mt-4">
            <ThemesTab scheme={scheme} onSchemeChange={setScheme} />
          </TabsContent>
          <TabsContent value="universal-login" className="mt-4">
            <UniversalLoginTab />
          </TabsContent>
          <TabsContent value="raw" className="mt-4">
            <RawJsonTab />
          </TabsContent>
        </UrlTabs>
      </div>
      <aside className="hidden w-[380px] shrink-0 lg:block">
        <div className="sticky top-4 h-[calc(100vh-6rem)]">
          <PreviewColumn scheme={scheme} onSchemeChange={setScheme} />
        </div>
      </aside>
    </div>
  );
}

export function BrandingEdit() {
  return (
    <Edit
      mutationMode="pessimistic"
      redirect={false}
      title="Branding"
      transform={transformBranding}
    >
      <SimpleForm className="max-w-none">
        <BrandingFormContent />
      </SimpleForm>
    </Edit>
  );
}
