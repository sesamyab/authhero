import { useRecordContext, useResourceContext } from "ra-core";
import { JsonOutput } from "@/common/JsonOutput";

export function RawTab() {
  const record = useRecordContext();
  const resource = useResourceContext() ?? "record";
  if (!record) return null;
  return <JsonOutput data={record} filename={`${resource}-${record.id}`} />;
}
