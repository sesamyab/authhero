import {
  Edit,
  SimpleForm,
  TextInput,
  SelectInput,
  required,
  ArrayInput,
  SimpleFormIterator,
  Labeled,
  FieldTitle,
  DateField,
  TextField,
  SaveButton,
  DeleteButton,
  useRecordContext,
  useNotify,
  Button,
} from "react-admin";
import { Box } from "@mui/material";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import { getConfigValue } from "../../utils/runtimeConfig";
import { createManagementClient } from "../../authProvider";
import { resolveApiBase } from "../../dataProvider";
import { useTenantId } from "../../TenantContext";
import { ActionTestPanel } from "./test-panel";

const triggerChoices = [
  { id: "post-login", name: "Post Login" },
  { id: "credentials-exchange", name: "Credentials Exchange" },
  { id: "pre-user-registration", name: "Pre User Registration" },
  { id: "post-user-registration", name: "Post User Registration" },
];

const SECRET_PLACEHOLDER = "******";

function DeployButton() {
  const record = useRecordContext();
  const notify = useNotify();
  const tenantId = useTenantId();

  const handleDeploy = async () => {
    if (!record?.id) return;
    try {
      const domain = getConfigValue("domain") || "";
      const apiUrl = resolveApiBase(domain);
      const client = await createManagementClient(apiUrl, tenantId, domain);
      await client.actions.deploy(String(record.id));
      notify("Action deployed successfully", { type: "success" });
    } catch (err: any) {
      notify(`Deploy failed: ${err.message}`, { type: "error" });
    }
  };

  return (
    <Button
      label="Deploy"
      onClick={handleDeploy}
      startIcon={<RocketLaunchIcon />}
    />
  );
}

function TopActionBar() {
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 2,
        mb: 2,
      }}
    >
      <SaveButton />
      <DeployButton />
      <DeleteButton mutationMode="pessimistic" />
    </Box>
  );
}

export function ActionEdit() {
  return (
    <Edit
      queryOptions={{
        select: (data: any) => ({
          ...data,
          trigger_id: data.supported_triggers?.[0]?.id,
          secrets: data.secrets?.map((s: any) => ({
            name: s.name,
            value: SECRET_PLACEHOLDER,
          })),
        }),
      }}
      transform={(data: any) => {
        const {
          id,
          tenant_id,
          created_at,
          updated_at,
          status,
          deployed_at,
          ...rest
        } = data;
        return {
          ...rest,
          supported_triggers: data.trigger_id
            ? [{ id: data.trigger_id }]
            : rest.supported_triggers,
          trigger_id: undefined,
          secrets: rest.secrets
            ?.filter((s: any) => s?.name)
            .map((s: any) =>
              s.value === SECRET_PLACEHOLDER
                ? { name: s.name }
                : { name: s.name, value: s.value },
            ),
        };
      }}
    >
      <SimpleForm toolbar={false}>
        <TopActionBar />
        <TextInput source="name" validate={[required()]} fullWidth />
        <SelectInput
          source="trigger_id"
          label="Trigger"
          choices={triggerChoices}
          fullWidth
          format={(value: any) => {
            if (!value) {
              return undefined;
            }
            return value;
          }}
        />
        <TextInput
          source="code"
          validate={[required()]}
          fullWidth
          multiline
          minRows={10}
          sx={{ "& .MuiInputBase-input": { fontFamily: "monospace" } }}
        />
        <TextInput source="runtime" fullWidth />
        <ArrayInput source="secrets">
          <SimpleFormIterator inline>
            <TextInput source="name" label="Name" />
            <TextInput source="value" label="Value" />
          </SimpleFormIterator>
        </ArrayInput>
        <ArrayInput source="dependencies">
          <SimpleFormIterator inline>
            <TextInput source="name" label="Package" />
            <TextInput source="version" label="Version" />
          </SimpleFormIterator>
        </ArrayInput>
        <Labeled label={<FieldTitle source="status" />}>
          <TextField source="status" />
        </Labeled>
        <Labeled label={<FieldTitle source="created_at" />}>
          <DateField source="created_at" showTime />
        </Labeled>
        <Labeled label={<FieldTitle source="updated_at" />}>
          <DateField source="updated_at" showTime />
        </Labeled>
        <ActionTestPanel />
      </SimpleForm>
    </Edit>
  );
}
