import { Edit, SimpleForm } from "@/components/admin";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/ui/url-tabs";
import { GeneralTab } from "./tabs/general-tab";
import { SessionTab } from "./tabs/session-tab";
import { SessionsManagementTab } from "./tabs/sessions-management-tab";
import { LocalizationTab } from "./tabs/localization-tab";
import { ErrorPageTab } from "./tabs/error-page-tab";
import { ChangePasswordTab } from "./tabs/change-password-tab";
import { FeatureFlagsTab } from "./tabs/feature-flags-tab";
import { AdvancedTab } from "./tabs/advanced-tab";
import { RawJsonTab } from "@/common/RawJsonTab";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeNullValues(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (isPlainObject(value)) {
      const cleaned = removeNullValues(value);
      if (Object.keys(cleaned).length > 0) result[key] = cleaned;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// The login-version toggle is a BooleanInput, which seeds an untouched field
// with `false` without running `parse`. Only "1" and "2" are valid values, so
// drop anything else rather than failing the whole save.
export function transformSettings(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = removeNullValues(data);
  if (isPlainObject(result.flags)) {
    const { universal_login_version, ...flags } = result.flags;
    result.flags =
      universal_login_version === "1" || universal_login_version === "2"
        ? { ...flags, universal_login_version }
        : flags;
  }
  return result;
}

export function SettingsEdit() {
  return (
    <Edit
      mutationMode="pessimistic"
      redirect={false}
      transform={transformSettings as never}
      actions={false}
    >
      <SimpleForm className="max-w-none">
        <UrlTabs defaultValue="general" className="w-full">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="session">Session</TabsTrigger>
            <TabsTrigger value="sessions-management">
              Sessions Management
            </TabsTrigger>
            <TabsTrigger value="localization">Localization</TabsTrigger>
            <TabsTrigger value="error-page">Error Page</TabsTrigger>
            <TabsTrigger value="change-password">Change Password</TabsTrigger>
            <TabsTrigger value="feature-flags">Feature Flags</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
            <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-4">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="session" className="mt-4">
            <SessionTab />
          </TabsContent>
          <TabsContent value="sessions-management" className="mt-4">
            <SessionsManagementTab />
          </TabsContent>
          <TabsContent value="localization" className="mt-4">
            <LocalizationTab />
          </TabsContent>
          <TabsContent value="error-page" className="mt-4">
            <ErrorPageTab />
          </TabsContent>
          <TabsContent value="change-password" className="mt-4">
            <ChangePasswordTab />
          </TabsContent>
          <TabsContent value="feature-flags" className="mt-4">
            <FeatureFlagsTab />
          </TabsContent>
          <TabsContent value="advanced" className="mt-4">
            <AdvancedTab />
          </TabsContent>
          <TabsContent value="raw" className="mt-4">
            <RawJsonTab />
          </TabsContent>
        </UrlTabs>
      </SimpleForm>
    </Edit>
  );
}
