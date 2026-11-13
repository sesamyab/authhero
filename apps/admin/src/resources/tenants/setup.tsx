import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useDataProvider, useGetList, useNotify } from "ra-core";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  AuthHeroDataProvider,
  TenantOperationEventRecord,
} from "@/auth0DataProvider";
import { useManagementPermissions } from "@/hooks/useManagementPermissions";
import { getBasePath } from "@/utils/runtimeConfig";
import { tenantHost, useDeploymentOptions } from "./deployment";

export const POLL_INTERVAL_MS = 2000;
// The dispatcher caches a miss for about 30 seconds, so a just-ready tenant
// can still answer 404 for a while.
const REACHABLE_TIMEOUT_MS = 60_000;

type ProvisioningState = "pending" | "ready" | "failed";

interface TenantRow {
  id: string;
  friendly_name?: string;
  provisioning_state?: ProvisioningState;
  provisioning_error?: string | null;
}

/** Readable names for the provisioner's steps. Unknown steps show as is. */
const STEP_LABELS: Record<string, string> = {
  "provision-resources": "Creating the database and worker",
  "seed-defaults": "Applying the default configuration",
};

function useProvisionEvents(
  tenantId: string,
  enabled: boolean,
  active: boolean,
): TenantOperationEventRecord[] {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const [events, setEvents] = useState<TenantOperationEventRecord[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { operations } = await dataProvider.listTenantOperations(
          tenantId,
          { perPage: 10 },
        );
        const latest = operations.find((op) =>
          ["provision", "upgrade"].includes(op.kind),
        );
        if (!latest) return;
        const { events } = await dataProvider.getTenantOperation(latest.id);
        if (!cancelled) setEvents(events);
      } catch {
        // The steps are a nicety; the tenant row still tells the state.
      }
    };
    load();
    if (!active)
      return () => {
        cancelled = true;
      };
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [dataProvider, tenantId, enabled, active]);

  return events;
}

/**
 * Waits for the tenant's own host to answer discovery before sending the user
 * in. Without a host template there is nothing to ask, so it is ready at once.
 */
function useReachable(host: string | undefined, ready: boolean): boolean {
  const [reachable, setReachable] = useState(false);

  useEffect(() => {
    if (!ready) return;
    if (!host) {
      setReachable(true);
      return;
    }
    let cancelled = false;
    const deadline = Date.now() + REACHABLE_TIMEOUT_MS;
    const check = async () => {
      try {
        const res = await fetch(
          `https://${host}/.well-known/openid-configuration`,
        );
        if (res.ok) {
          if (!cancelled) setReachable(true);
          return;
        }
      } catch {
        // Not reachable yet.
      }
      if (cancelled) return;
      if (Date.now() > deadline) {
        // Give up waiting; the button below still lets the user go in.
        setReachable(true);
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [host, ready]);

  return reachable;
}

function StepList({ events }: { events: TenantOperationEventRecord[] }) {
  // The latest outcome per step, in the order the steps started.
  const steps = new Map<string, TenantOperationEventRecord["outcome"]>();
  for (const event of events) steps.set(event.step, event.outcome);
  if (steps.size === 0) return null;
  return (
    <ul className="flex flex-col gap-2 text-left text-sm">
      {[...steps].map(([step, outcome]) => (
        <li key={step} className="flex items-center gap-2">
          {outcome === "succeeded" ? (
            <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
          ) : outcome === "failed" ? (
            <XCircle className="h-4 w-4 text-destructive" aria-hidden />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          )}
          <span>{STEP_LABELS[step] ?? step}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Shown right after a tenant is created, while it is provisioned. It can be
 * reloaded: it reads the state from the tenant each time.
 */
export function TenantSetup() {
  const { tenantId = "" } = useParams<{ tenantId: string }>();
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();
  const { can } = useManagementPermissions();
  const deploymentOptions = useDeploymentOptions();
  const [retrying, setRetrying] = useState(false);

  // Read from the list the user can see rather than with getOne, whose
  // fallback for a tenant it cannot find is a bare record with no state;
  // that would read as "ready" and send the user into a tenant they cannot
  // open. A tenant missing from the list is reported as not found.
  const findTenant = (rows: TenantRow[] | undefined) =>
    rows?.find((row) => row.id === tenantId);
  const {
    data: rows,
    error: listError,
    isPending,
    refetch,
  } = useGetList<TenantRow>(
    "tenants",
    {
      pagination: { page: 1, perPage: 100 },
      sort: { field: "id", order: "ASC" },
    },
    {
      refetchInterval: (query) =>
        findTenant(query.state.data?.data)?.provisioning_state === "pending"
          ? POLL_INTERVAL_MS
          : false,
    },
  );
  const tenant = findTenant(rows);
  const error = listError ?? (!isPending && !tenant ? true : undefined);

  const state: ProvisioningState | undefined = tenant
    ? (tenant.provisioning_state ?? "ready")
    : undefined;
  const events = useProvisionEvents(
    tenantId,
    can("read:tenant_operations"),
    state === "pending",
  );
  const template = deploymentOptions?.tenant_host_template;
  const host = template ? tenantHost(template, tenantId) : undefined;
  const reachable = useReachable(host, state === "ready");
  const tenantUrl = `${getBasePath()}/${encodeURIComponent(tenantId)}`;

  useEffect(() => {
    if (state === "ready" && reachable) window.location.href = tenantUrl;
  }, [state, reachable, tenantUrl]);

  const retry = async () => {
    setRetrying(true);
    try {
      await dataProvider.createTenantOperation(tenantId, "upgrade");
      await refetch();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not retry", {
        type: "error",
      });
    } finally {
      setRetrying(false);
    }
  };

  const name = tenant?.friendly_name || tenantId;

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-lg text-center">
        {error ? (
          <CardHeader>
            <CardTitle>Tenant not found</CardTitle>
            <CardDescription>
              It may have been removed, or you may not have access to it.
            </CardDescription>
            <div className="pt-2">
              <Button asChild variant="outline">
                <Link to="/tenants">Back to tenants</Link>
              </Button>
            </div>
          </CardHeader>
        ) : state === "failed" ? (
          <>
            <CardHeader className="items-center">
              <XCircle
                className="mx-auto h-10 w-10 text-destructive"
                aria-hidden
              />
              <CardTitle>Setting up {name} failed</CardTitle>
              {/* The provisioner's error names infrastructure (API answers,
                  script and database ids), so only operators see it. */}
              <CardDescription className="break-words">
                {can("read:tenant_operations") && tenant?.provisioning_error
                  ? tenant.provisioning_error
                  : "Something went wrong while setting up your tenant."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-3">
              <StepList events={events} />
              {can("create:tenant_operations") ? (
                <Button onClick={retry} disabled={retrying}>
                  <RefreshCw className="h-4 w-4 mr-1" />
                  {retrying ? "Retrying…" : "Retry"}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Contact support and mention the tenant id{" "}
                  <code>{tenantId}</code>.
                </p>
              )}
            </CardContent>
          </>
        ) : state === "ready" ? (
          <CardHeader className="items-center">
            {reachable ? (
              <CheckCircle2
                className="mx-auto h-10 w-10 text-green-600"
                aria-hidden
              />
            ) : (
              <Loader2 className="mx-auto h-10 w-10 animate-spin" aria-hidden />
            )}
            <CardTitle>{name} is ready</CardTitle>
            <CardDescription>
              {reachable
                ? "Opening your tenant…"
                : "Waiting for it to come online…"}
            </CardDescription>
            <div className="pt-2">
              <Button asChild>
                <a href={tenantUrl}>Open tenant</a>
              </Button>
            </div>
          </CardHeader>
        ) : (
          <>
            <CardHeader className="items-center">
              <Loader2 className="mx-auto h-10 w-10 animate-spin" aria-hidden />
              <CardTitle>Setting up {name}</CardTitle>
              <CardDescription>
                This usually takes less than a minute. You can leave this page
                and come back.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex justify-center">
              <StepList events={events} />
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}
