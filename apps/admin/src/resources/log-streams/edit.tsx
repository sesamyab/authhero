import { Edit, SimpleForm, TextInput, SelectInput } from "@/components/admin";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/ui/url-tabs";
import { required } from "ra-core";
import { RawJsonTab } from "@/common/RawJsonTab";
import { statusChoices, typeChoices } from "./logStreamConstants";
import { SinkFields } from "./sink-fields";

function DetailsTab() {
  return (
    <>
      <TextInput source="name" validate={[required()]} />
      <SelectInput
        source="type"
        choices={typeChoices}
        validate={[required()]}
        disabled
        helperText="Type cannot be changed after creation"
      />
      <SelectInput
        source="status"
        choices={statusChoices}
        validate={[required()]}
      />
      <SinkFields mode="edit" />
    </>
  );
}

type LogStreamEditValues = {
  clear_http_authorization?: boolean;
  sink?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * The Authorization header is write-only, so a blank field keeps the stored
 * one; the API removes it only when the sink sends `null`.
 */
export function toLogStreamUpdate({
  clear_http_authorization,
  ...data
}: LogStreamEditValues) {
  if (!clear_http_authorization) return data;
  return { ...data, sink: { ...data.sink, http_authorization: null } };
}

export function LogStreamEdit() {
  return (
    <Edit mutationMode="pessimistic" transform={toLogStreamUpdate}>
      <SimpleForm className="max-w-none">
        <UrlTabs defaultValue="details" className="w-full">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="mt-4">
            <DetailsTab />
          </TabsContent>
          <TabsContent value="raw" className="mt-4">
            <RawJsonTab />
          </TabsContent>
        </UrlTabs>
      </SimpleForm>
    </Edit>
  );
}
