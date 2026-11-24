import { Create, SimpleForm, TextInput, SelectInput } from "@/components/admin";
import { required } from "ra-core";
import { statusChoices, typeChoices } from "./logStreamConstants";
import { SinkFields } from "./sink-fields";

type LogStreamFormValues = {
  type?: string;
  status?: string;
  sink?: {
    http_endpoint?: string;
    http_authorization?: string;
    http_content_type?: string;
    http_content_format?: string;
    aws_region?: string;
    delivery_stream_name?: string;
    aws_access_key_id?: string;
    aws_secret_access_key?: string;
    newline_delimited?: boolean;
  };
};

// Only the selected type's fields are sent, so switching type in the form
// doesn't leave the other type's values in the sink.
export function buildSink(data: LogStreamFormValues) {
  const sink = data.sink ?? {};
  if (data.type === "firehose") {
    return {
      aws_region: sink.aws_region,
      delivery_stream_name: sink.delivery_stream_name,
      aws_access_key_id: sink.aws_access_key_id,
      aws_secret_access_key: sink.aws_secret_access_key,
      newline_delimited: sink.newline_delimited ?? true,
    };
  }
  return {
    http_endpoint: sink.http_endpoint,
    http_authorization: sink.http_authorization,
    http_content_type: sink.http_content_type || "application/json",
    http_content_format: sink.http_content_format || "JSONARRAY",
  };
}

export function LogStreamCreate() {
  return (
    <Create
      transform={(data: LogStreamFormValues) => ({
        ...data,
        status: data.status ?? "active",
        sink: buildSink(data),
      })}
    >
      <SimpleForm defaultValues={{ type: "http", status: "active" }}>
        <TextInput source="name" validate={[required()]} />
        <SelectInput
          source="type"
          choices={typeChoices}
          validate={[required()]}
          helperText="HTTP endpoints and Amazon Data Firehose streams are delivered by AuthHero"
        />
        <SelectInput source="status" choices={statusChoices} />
        <SinkFields mode="create" />
      </SimpleForm>
    </Create>
  );
}
