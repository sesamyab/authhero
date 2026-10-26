import { useRecordContext } from "ra-core";
import { Badge } from "@/components/ui/badge";
import { isSyncedRowId, rowIdOf } from "@/lib/syncedRows";

/** List cell: "inherited" for rows a sync copied from a parent. */
export function InheritedBadge({ fallback }: { fallback?: string }) {
  const record = useRecordContext<{
    id?: string;
    hook_id?: string;
    scope?: string | null;
  }>();
  if (!record) return null;
  if (isSyncedRowId(rowIdOf(record))) {
    return <Badge variant="secondary">inherited</Badge>;
  }
  if (record.scope === "shared" || record.scope === "platform") {
    return <Badge variant="outline">{record.scope}</Badge>;
  }
  return <>{fallback ?? "local"}</>;
}
