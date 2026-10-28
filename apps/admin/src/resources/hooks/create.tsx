import {
  Create,
  SimpleForm,
  TextInput,
  SelectInput,
  BooleanInput,
  NumberInput,
  ReferenceInput,
  AutocompleteInput,
} from "@/components/admin";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { required, useCreatePath } from "ra-core";
import { useFormContext, useWatch } from "react-hook-form";
import {
  getTemplateChoicesForTrigger,
  getTriggerChoicesForType,
  pageChoices,
  getBindingTypeChoices,
} from "./hookConstants";

import { ActionInput } from "./action-input";
import { bindingCreatePayload } from "../action-triggers/bindings";

function TypeField() {
  const triggerId = useWatch({ name: "trigger_id" }) as string | undefined;
  return (
    <SelectInput
      source="type"
      label="Binding type"
      choices={getBindingTypeChoices(triggerId)}
      validate={required()}
    />
  );
}

function TypeSpecificFields() {
  const type = useWatch({ name: "type" });
  const triggerId = useWatch({ name: "trigger_id" });

  if (type === "url") {
    return <TextInput source="url" label="Webhook URL" required />;
  }
  if (type === "form") {
    return (
      <ReferenceInput source="form_id" reference="forms">
        <AutocompleteInput
          label="Form"
          optionText="name"
          validate={required()}
        />
      </ReferenceInput>
    );
  }
  if (type === "template") {
    return (
      <SelectInput
        source="template_id"
        label="Template"
        choices={getTemplateChoicesForTrigger(triggerId)}
        validate={required()}
      />
    );
  }
  if (type === "code") {
    return <ActionInput />;
  }
  if (type === "page") {
    return (
      <>
        <SelectInput
          source="page_id"
          label="Page"
          choices={pageChoices}
          validate={required()}
        />
        <TextInput
          source="permission_required"
          label="Permission required"
          helperText="Only interrupt the login for users holding this permission (e.g. users:impersonate). Leave empty to show the page on every login."
        />
      </>
    );
  }
  return null;
}

function BindingOptions() {
  const type = useWatch({ name: "type" });
  const templateId = useWatch({ name: "template_id" });
  return (
    <>
      <BooleanInput source="enabled" label="Enabled" />
      {type === "url" && (
        <BooleanInput source="synchronous" label="Synchronous" />
      )}
      <NumberInput source="priority" label="Priority" />
      <BooleanInput source="metadata.inheritable" label="Inheritable" />
      {type === "template" && templateId === "account-linking" && (
        <BooleanInput
          source="metadata.copy_user_metadata"
          label="Copy user metadata"
        />
      )}
    </>
  );
}

/**
 * Form, page and code hooks each run on a subset of the triggers, so offering
 * the rest would just produce a 400 from the management API — or, before the
 * form-hook trigger list was narrowed, a hook that stored fine and never ran.
 */
function TriggerField() {
  const type = useWatch({ name: "type" });
  const triggerId = useWatch({ name: "trigger_id" });
  const { setValue } = useFormContext();
  const choices = getTriggerChoicesForType(type);

  // Narrowing the choices does not narrow what the form already holds: a
  // trigger picked under the previous type stays in form state, invisible in
  // a select that no longer offers it, and submits as a 400 from the
  // management API. Drop it as soon as it stops being a valid choice.
  useEffect(() => {
    if (triggerId && !choices.some((choice) => choice.id === triggerId)) {
      setValue("trigger_id", "");
    }
  }, [triggerId, choices, setValue]);

  return (
    <SelectInput
      source="trigger_id"
      label="Trigger"
      choices={choices}
      validate={required()}
    />
  );
}

export function HooksCreate() {
  const createPath = useCreatePath();
  const triggersPath = createPath({
    resource: "action-triggers",
    type: "list",
  });
  return (
    <Create
      title="Add trigger binding"
      redirect={triggersPath}
      transform={bindingCreatePayload}
      disableBreadcrumb
    >
      <Link to={triggersPath} className="text-sm text-primary underline">
        Back to Triggers
      </Link>
      <SimpleForm defaultValues={{ enabled: true, priority: 0 }}>
        <TypeField />
        <TriggerField />
        <TypeSpecificFields />
        <BindingOptions />
      </SimpleForm>
    </Create>
  );
}
