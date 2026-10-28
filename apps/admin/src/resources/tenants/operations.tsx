import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useDataProvider, useNotify } from "ra-core";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Rocket,
  RefreshCcw,
  Eye,
  Unlink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Confirm } from "@/components/admin/confirm";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LatestSyncCard } from "@/components/inheritance/LatestSyncCard";
import { SyncChanges } from "@/components/inheritance/SyncChanges";
import { SyncStatusCard } from "@/components/inheritance/SyncStatusCard";
import type {
  AuthHeroDataProvider,
  TenantOperationRecord,
  TenantOperationEventRecord,
} from "@/auth0DataProvider";

const STATUS_VARIANT: Record<
  TenantOperationRecord["status"],
  "default" | "outline" | "secondary" | "destructive"
> = {
  pending: "secondary",
  running: "secondary",
  succeeded: "outline",
  failed: "destructive",
  cancelled: "secondary",
};

const OUTCOME_VARIANT: Record<
  TenantOperationEventRecord["outcome"],
  "default" | "outline" | "secondary" | "destructive"
> = {
  started: "secondary",
  succeeded: "outline",
  failed: "destructive",
  retried: "secondary",
  skipped: "secondary",
  reconciled: "secondary",
};

const ACTIVE_STATUSES: TenantOperationRecord["status"][] = [
  "pending",
  "running",
];
const POLL_INTERVAL_MS = 4000;

function formatTimestamp(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(operation: TenantOperationRecord): string {
  const start = new Date(operation.created_at).getTime();
  const end = operation.finished_at
    ? new Date(operation.finished_at).getTime()
    : Date.now();
  if (isNaN(start) || isNaN(end) || end < start) return "—";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function EventsTimeline({ events }: { events: TenantOperationEventRecord[] }) {
  if (events.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No step events recorded for this operation.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-1 py-2">
      {events.map((event) => (
        <li key={event.id} className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground whitespace-nowrap">
            {formatTimestamp(event.created_at)}
          </span>
          <span className="font-mono">{event.step}</span>
          <Badge variant={OUTCOME_VARIANT[event.outcome] ?? "secondary"}>
            {event.outcome}
          </Badge>
          {event.attempt > 1 ? (
            <span className="text-muted-foreground">
              attempt {event.attempt}
            </span>
          ) : null}
          {event.detail ? (
            <span
              className="text-muted-foreground truncate max-w-md"
              title={JSON.stringify(event.detail, null, 2)}
            >
              {JSON.stringify(event.detail)}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "unavailable" }
  | { status: "error" };

/**
 * Control-plane view of a tenant's lifecycle operation history
 * (issue #1026): every provision/upgrade run with its per-step event
 * timeline, plus a redeploy control that enqueues an upgrade operation.
 * Polls while an operation is in flight — the server marks it terminal.
 */
export function TenantOperations() {
  const { tenantId } = useParams();
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();

  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [operations, setOperations] = useState<TenantOperationRecord[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [events, setEvents] = useState<
    Record<string, TenantOperationEventRecord[]>
  >({});
  const [enqueuing, setEnqueuing] = useState(false);
  const [prune, setPrune] = useState(false);
  const [detachOpen, setDetachOpen] = useState(false);
  const [detachClean, setDetachClean] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!tenantId) return;
    try {
      const result = await dataProvider.listTenantOperations(tenantId, {
        page: 1,
        perPage: 50,
      });
      if (!mounted.current) return;
      setOperations(result.operations);
      setLoadState({ status: "ready" });
    } catch (error) {
      if (!mounted.current) return;
      const status =
        error && typeof error === "object" && "status" in error
          ? Number(error.status)
          : undefined;
      // 404 = the routes aren't mounted (no operations adapters on this
      // deployment); anything else is a real failure.
      setLoadState(
        status === 404 ? { status: "unavailable" } : { status: "error" },
      );
    }
  }, [dataProvider, tenantId]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // Poll while anything is in flight so terminal states appear without a
  // manual refresh.
  const hasActive = operations.some((op) =>
    ACTIVE_STATUSES.includes(op.status),
  );
  useEffect(() => {
    if (!hasActive) return;
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasActive, refresh]);

  const loadEvents = useCallback(
    async (operationId: string) => {
      try {
        const detail = await dataProvider.getTenantOperation(operationId);
        if (!mounted.current) return;
        setEvents((prev) => ({ ...prev, [operationId]: detail.events }));
      } catch {
        // Row stays expandable; timeline just shows the empty state.
      }
    },
    [dataProvider],
  );

  const toggleExpanded = (operationId: string) => {
    const next = expandedId === operationId ? null : operationId;
    setExpandedId(next);
    if (next) loadEvents(next);
  };

  // Keep the expanded timeline live while its operation runs.
  useEffect(() => {
    if (!expandedId) return;
    const operation = operations.find((op) => op.id === expandedId);
    if (!operation || !ACTIVE_STATUSES.includes(operation.status)) return;
    const interval = setInterval(
      () => loadEvents(expandedId),
      POLL_INTERVAL_MS,
    );
    return () => clearInterval(interval);
  }, [expandedId, operations, loadEvents]);

  const enqueue = async (
    kind: "upgrade" | "sync-defaults" | "detach",
    input:
      | {
          dry_run?: boolean;
          force?: boolean;
          prune?: boolean;
          clean?: boolean;
        }
      | undefined,
    label: string,
  ) => {
    if (!tenantId) return;
    setEnqueuing(true);
    try {
      const operation = await dataProvider.createTenantOperation(
        tenantId,
        kind,
        input,
      );
      // A sync returns its finished row, failed or not: say which.
      notify(
        operation.status === "failed"
          ? `${label} failed: ${operation.error ?? "see the timeline"}`
          : `${label} operation ${operation.status === "succeeded" ? "finished" : "enqueued"}`,
        { type: operation.status === "failed" ? "error" : "info" },
      );
      await refresh();
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : `Failed to enqueue: ${label}`;
      notify(message, { type: "error" });
    } finally {
      if (mounted.current) setEnqueuing(false);
    }
  };
  const enqueueUpgrade = () => enqueue("upgrade", undefined, "Upgrade");

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/tenants">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to tenants
          </Link>
        </Button>
      </div>

      <SyncStatusCard
        tenantId={tenantId}
        refreshToken={operations.map((o) => `${o.id}:${o.status}`).join(",")}
      />

      <LatestSyncCard operations={operations} />

      <Confirm
        isOpen={detachOpen}
        title={`Detach "${tenantId}" from its parent?`}
        content={
          <div className="flex flex-col gap-3">
            <p>
              The tenant keeps the config it inherited as its own rows, and
              nothing is inherited or synced into it again. Rows a platform owns
              stay as copies. Run <em>Preview detach</em> first to see what
              changes.
            </p>
            <div className="flex items-center gap-2">
              <Checkbox
                id="detach-clean"
                checked={detachClean}
                onCheckedChange={(v) => setDetachClean(v === true)}
              />
              <Label htmlFor="detach-clean">
                Remove the inherited rows instead of keeping them
              </Label>
            </div>
          </div>
        }
        confirm="Detach"
        confirmColor="warning"
        ConfirmIcon={Unlink}
        onConfirm={() => {
          setDetachOpen(false);
          void enqueue(
            "detach",
            detachClean ? { clean: true } : undefined,
            "Detach",
          );
        }}
        onClose={() => setDetachOpen(false)}
        loading={enqueuing}
      />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>Operations for {tenantId}</CardTitle>
            <CardDescription>
              Lifecycle operation history — every provision, seed, and upgrade
              run with its step-by-step timeline. Retrying is safe: steps are
              idempotent.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <div
              className="flex items-center gap-2"
              title="Also remove synced copies the parent no longer shares. A preview always lists them."
            >
              <Checkbox
                id="sync-prune"
                checked={prune}
                onCheckedChange={(v) => setPrune(v === true)}
              />
              <Label htmlFor="sync-prune">Remove unshared</Label>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={loadState.status === "loading"}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                enqueue("sync-defaults", { dry_run: true }, "Sync preview")
              }
              disabled={enqueuing || hasActive}
              title="Show what a sync would change, without writing anything"
            >
              <Eye className="h-4 w-4 mr-1" />
              Preview sync
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                enqueue(
                  "sync-defaults",
                  { force: true, ...(prune ? { prune: true } : {}) },
                  "Forced sync",
                )
              }
              disabled={enqueuing || hasActive}
              title="Apply the config even when the tenant is already up to date"
            >
              <RefreshCcw className="h-4 w-4 mr-1" />
              Force sync
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                enqueue(
                  "sync-defaults",
                  prune ? { prune: true } : undefined,
                  "Sync",
                )
              }
              disabled={enqueuing || hasActive}
              title="Copy the config this tenant inherits into its own database"
            >
              <RefreshCcw className="h-4 w-4 mr-1" />
              Sync config
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                enqueue("detach", { dry_run: true }, "Detach preview")
              }
              disabled={enqueuing || hasActive}
              title="Show what detaching this tenant from its parent would do, without writing anything"
            >
              <Eye className="h-4 w-4 mr-1" />
              Preview detach
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDetachOpen(true)}
              disabled={enqueuing || hasActive}
              title="Make this tenant independent of its parent"
            >
              <Unlink className="h-4 w-4 mr-1" />
              Detach
            </Button>
            <Button
              size="sm"
              onClick={enqueueUpgrade}
              disabled={enqueuing || hasActive}
              title={
                hasActive
                  ? "An operation is already in flight for this tenant"
                  : undefined
              }
            >
              {enqueuing ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4 mr-1" />
              )}
              Redeploy
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadState.status === "loading" ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading operations…</span>
            </div>
          ) : loadState.status === "unavailable" ? (
            <p className="py-8 text-sm text-muted-foreground">
              Tenant operations aren&apos;t enabled for this deployment. The
              control plane needs the tenant-operations adapters configured.
            </p>
          ) : loadState.status === "error" ? (
            <p className="py-8 text-sm text-destructive">
              Could not load operations for this tenant. Check that you have the
              read:tenant_operations permission and try again.
            </p>
          ) : operations.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">
              No operations recorded for this tenant yet. Operations appear here
              when the tenant is provisioned, seeded, or upgraded.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Current step</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Initiated by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {operations.map((operation) => (
                  <Fragment key={operation.id}>
                    <TableRow
                      className="cursor-pointer"
                      role="button"
                      tabIndex={0}
                      aria-expanded={expandedId === operation.id}
                      onClick={() => toggleExpanded(operation.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleExpanded(operation.id);
                        }
                      }}
                    >
                      <TableCell>
                        {expandedId === operation.id ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono">
                        {operation.kind}
                      </TableCell>
                      <TableCell>
                        <span title={operation.error ?? undefined}>
                          <Badge variant={STATUS_VARIANT[operation.status]}>
                            {operation.status}
                          </Badge>
                        </span>
                      </TableCell>
                      <TableCell className="font-mono">
                        {operation.current_step ?? "—"}
                      </TableCell>
                      <TableCell>
                        {formatTimestamp(operation.created_at)}
                      </TableCell>
                      <TableCell>{formatDuration(operation)}</TableCell>
                      <TableCell className="truncate max-w-40">
                        {operation.initiated_by ?? "—"}
                      </TableCell>
                    </TableRow>
                    {expandedId === operation.id ? (
                      <TableRow>
                        <TableCell />
                        <TableCell colSpan={6}>
                          {operation.error ? (
                            <p className="py-1 text-sm text-destructive">
                              {operation.error}
                            </p>
                          ) : null}
                          {operation.kind === "sync-defaults" ||
                          operation.kind === "detach" ? (
                            <div className="py-2">
                              <SyncChanges result={operation.result} />
                            </div>
                          ) : null}
                          {events[operation.id] ? (
                            <EventsTimeline events={events[operation.id]!} />
                          ) : (
                            <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              <span>Loading events…</span>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
