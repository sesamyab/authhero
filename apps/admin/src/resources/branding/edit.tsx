import { useState } from "react";
import { useWatch } from "react-hook-form";
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
    <div className="flex max-w-2xl flex-col gap-4">
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
        helperText="Default color scheme for the universal login page. The per-user ah-dark-mode cookie still overrides this at runtime."
        choices={[
          { id: "auto", name: "Auto (follow system)" },
          { id: "light", name: "Light" },
          { id: "dark", name: "Dark" },
        ]}
      />
    </div>
  );
}

function BrandingFormContent() {
  // One scheme for both: the theme form edits it, the preview shows it.
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  return (
    <div className="flex w-full gap-6">
      <div className="min-w-0 flex-1">
        <UrlTabs defaultValue="style">
          <TabsList>
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
          <BrandingPreview
            colorScheme={scheme}
            onColorSchemeChange={setScheme}
          />
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
