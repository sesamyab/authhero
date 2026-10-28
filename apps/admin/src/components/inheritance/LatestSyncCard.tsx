import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TenantOperationRecord } from "@/auth0DataProvider";
import { SyncChanges } from "./SyncChanges";

const isPreview = (operation: TenantOperationRecord) =>
  operation.input?.dry_run === true;

const newest = (
  operations: TenantOperationRecord[],
  match: (operation: TenantOperationRecord) => boolean,
) =>
  operations
    .filter((o) => o.kind === "sync-defaults" && match(o))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

function when(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date.toLocaleString();
}

function Section({
  title,
  operation,
}: {
  title: string;
  operation: TenantOperationRecord | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        {operation && (
          <span className="text-xs text-muted-foreground">
            {when(operation.created_at)}
          </span>
        )}
        {operation && operation.status !== "succeeded" && (
          <Badge
            variant={
              operation.status === "failed" ? "destructive" : "secondary"
            }
          >
            {operation.status}
          </Badge>
        )}
      </div>
      {!operation ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : operation.result ? (
        <SyncChanges result={operation.result} />
      ) : operation.error ? (
        <p className="text-sm text-destructive">{operation.error}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Running…</p>
      )}
    </div>
  );
}

/**
 * The latest preview and the latest sync of a tenant, so what the next sync
 * will do and what the last one did can be read without opening the history.
 * A preview is a snapshot: run it again after changing the parent.
 */
export function LatestSyncCard({
  operations,
}: {
  operations: TenantOperationRecord[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Config sync changes</CardTitle>
        <CardDescription>
          What the next sync would do (from the latest preview) and what the
          last sync did. Run <em>Preview sync</em> after changing the parent to
          refresh the first.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <Section
          title="Latest preview"
          operation={newest(operations, isPreview)}
        />
        <Section
          title="Latest sync"
          operation={newest(operations, (o) => !isPreview(o))}
        />
      </CardContent>
    </Card>
  );
}
