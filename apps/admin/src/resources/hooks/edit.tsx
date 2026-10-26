import { Edit, SimpleForm } from "@/components/admin";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/ui/url-tabs";
import { InheritedFieldset } from "@/components/inheritance/InheritedFieldset";
import { PublishingFields } from "@/components/inheritance/PublishingFields";
import { DetailsTab } from "./tabs/details-tab";
import { RawJsonTab } from "@/common/RawJsonTab";

export function HookEdit() {
  return (
    <Edit mutationMode="pessimistic">
      <SimpleForm className="max-w-none">
        <UrlTabs defaultValue="details" className="w-full">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="mt-4">
            <InheritedFieldset>
              <DetailsTab />
              <PublishingFields />
            </InheritedFieldset>
          </TabsContent>
          <TabsContent value="raw" className="mt-4">
            <RawJsonTab />
          </TabsContent>
        </UrlTabs>
      </SimpleForm>
    </Edit>
  );
}
