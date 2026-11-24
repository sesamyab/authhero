import { List, DataTable } from "@/components/admin";
import { useRecordContext } from "ra-core";

function EndpointField() {
  const record = useRecordContext<{
    type?: string;
    sink?: {
      http_endpoint?: string;
      aws_region?: string;
      delivery_stream_name?: string;
    };
  }>();
  if (record?.type === "firehose") {
    const { delivery_stream_name, aws_region } = record.sink ?? {};
    return (
      <>
        {delivery_stream_name ? `${delivery_stream_name} (${aws_region})` : "—"}
      </>
    );
  }
  return <>{record?.sink?.http_endpoint ?? "—"}</>;
}

export function LogStreamsList() {
  return (
    <List>
      <DataTable rowClick="edit">
        <DataTable.Col source="name" />
        <DataTable.Col source="type" />
        <DataTable.Col source="status" />
        <DataTable.Col label="Endpoint">
          <EndpointField />
        </DataTable.Col>
      </DataTable>
    </List>
  );
}
