import { TextInput } from "@/components/admin";

export function GeneralTab() {
  return (
    <div className="flex flex-col gap-3">
      <TextInput source="friendly_name" label="Friendly Name" />
      <TextInput source="picture_url" label="Picture URL" />
      <TextInput source="support_email" label="Support Email" />
      <TextInput source="support_url" label="Support URL" />
      <TextInput
        source="sender_email"
        label="Sender Email"
        helperText="The address outgoing email is sent from, unless the email provider sets its own."
      />
      <TextInput
        source="sender_name"
        label="Sender Name"
        helperText="Shown as the sender name. Defaults to the friendly name."
      />
      <TextInput
        source="audience"
        label="Audience"
        disabled
        helperText="Identifies this tenant in service tokens. Set when the tenant is created and can't be changed here."
      />
      <TextInput source="default_directory" label="Default Directory" />
      <TextInput source="default_audience" label="Default Audience" />
      <TextInput source="default_organization" label="Default Organization" />
      <TextInput
        source="default_redirection_uri"
        label="Default Redirection URI"
      />
    </div>
  );
}
