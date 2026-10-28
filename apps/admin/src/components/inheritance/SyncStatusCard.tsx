import { VerifyConfig } from "./VerifyConfig";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useConfigSyncStatus } from "@/hooks/useConfigSyncStatus";

function formatTimestamp(value?: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date.toLocaleString();
}

const short = (hash?: string | null) => (hash ? hash.slice(0, 12) : "none");

/**
 * Where a tenant's config comes from and whether it is current: its parent,
 * the sync mode, when it was last synced and, for a synced tenant, whether
 * the parent chain has moved on since (drift).
 */
export function SyncStatusCard({
  tenantId,
  refreshToken,
}: {
  tenantId?: string;
  refreshToken?: string;
}) {
  const { status, loading } = useConfigSyncStatus(tenantId, refreshToken);
  if (loading || !status) return null;

  const synced = status.config_sync === "synced";
  const detached = status.config_sync === "detached";

  return (
    <Card data-testid="sync-status-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Config sync
          {synced ? (
            status.drifted ? (
              <Badge variant="destructive">Out of date</Badge>
            ) : (
              <Badge variant="outline">In sync</Badge>
            )
          ) : detached ? (
            <Badge variant="secondary">Detached</Badge>
          ) : (
            <Badge variant="secondary">Inherit on read</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {synced
            ? "This tenant keeps its own copy of the config it inherits."
            : detached
              ? "This tenant has left its parent: it reads only its own config and nothing is synced into it."
              : "Inherited config is merged in at request time; nothing is copied."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Parent</dt>
          <dd>{status.parent_tenant_id ?? status.chain[0] ?? "none"}</dd>
          {status.chain.length > 1 && (
            <>
              <dt className="text-muted-foreground">Inherits from</dt>
              <dd>{status.chain.join(" \u2192 ")}</dd>
            </>
          )}
          {synced && (
            <>
              <dt className="text-muted-foreground">Last synced</dt>
              <dd>{formatTimestamp(status.config_synced_at)}</dd>
              <dt className="text-muted-foreground">Applied</dt>
              <dd className="font-mono">{short(status.config_sync_hash)}</dd>
              <dt className="text-muted-foreground">Current</dt>
              <dd className="font-mono">{short(status.expected_hash)}</dd>
            </>
          )}
        </dl>
        {!detached && <VerifyConfig tenantId={status.tenant_id} />}
      </CardContent>
    </Card>
  );
}
