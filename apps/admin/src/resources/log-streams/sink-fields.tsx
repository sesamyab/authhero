import { useWatch } from "react-hook-form";
import { regex, required } from "ra-core";
import { BooleanInput, SelectInput, TextInput } from "@/components/admin";
import { SecretInput } from "@/common/SecretInput";
import { contentFormatChoices } from "./logStreamConstants";

function HttpSinkFields({ mode }: { mode: "create" | "edit" }) {
  return (
    <>
      <TextInput
        source="sink.http_endpoint"
        label="HTTP endpoint"
        validate={[
          required(),
          regex(/^https?:\/\/[^\s]+$/i, "Must be a valid http(s) URL"),
        ]}
      />
      <SecretInput
        source="sink.http_authorization"
        label="Authorization header"
        autoComplete="new-password"
        helperText={
          mode === "edit"
            ? "Write-only. Leave blank to keep the current header."
            : 'Sent verbatim as the Authorization header (e.g. "Basic …" or "Bearer …"). Write-only: it is stored but never shown again.'
        }
      />
      {mode === "edit" && (
        <BooleanInput
          source="clear_http_authorization"
          label="Remove the stored Authorization header"
        />
      )}
      <TextInput
        source="sink.http_content_type"
        label="Content-Type"
        defaultValue={mode === "create" ? "application/json" : undefined}
      />
      <SelectInput
        source="sink.http_content_format"
        label="Content format"
        choices={contentFormatChoices}
        defaultValue={mode === "create" ? "JSONARRAY" : undefined}
      />
    </>
  );
}

function FirehoseSinkFields({ mode }: { mode: "create" | "edit" }) {
  return (
    <>
      <TextInput
        source="sink.aws_region"
        label="AWS region"
        validate={[
          required(),
          regex(/^[a-z0-9-]+$/, "Must be an AWS region id, e.g. eu-north-1"),
        ]}
      />
      <TextInput
        source="sink.delivery_stream_name"
        label="Delivery stream name"
        helperText="The name (not the ARN) of a Direct PUT delivery stream"
        validate={[required()]}
      />
      <TextInput
        source="sink.aws_access_key_id"
        label="AWS access key ID"
        helperText="Of an IAM user allowed only firehose:PutRecordBatch on this stream"
        validate={[required()]}
      />
      <SecretInput
        source="sink.aws_secret_access_key"
        label="AWS secret access key"
        autoComplete="new-password"
        helperText={
          mode === "edit"
            ? "Write-only. Leave blank to keep the current secret."
            : "Write-only: it is stored but never shown again."
        }
        validate={mode === "create" ? [required()] : undefined}
      />
      <BooleanInput
        source="sink.newline_delimited"
        label="Newline-delimited records"
        helperText="End each record with a newline, so S3 objects are JSON Lines"
        defaultValue={true}
      />
    </>
  );
}

/** The sink inputs for the log stream type currently selected in the form. */
export function SinkFields({ mode }: { mode: "create" | "edit" }) {
  const type: unknown = useWatch({ name: "type" });
  return type === "firehose" ? (
    <FirehoseSinkFields mode={mode} />
  ) : (
    <HttpSinkFields mode={mode} />
  );
}
