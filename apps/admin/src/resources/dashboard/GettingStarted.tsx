import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDataProvider } from "ra-core";
import { CheckCircle2, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTenantId } from "@/TenantContext";
import { LogTypes } from "@/lib/logs";
import { cn } from "@/lib/utils";

export interface GettingStartedProgress {
  users?: number;
}

/** What the checklist reads from the tenant beyond the dashboard's counts. */
export interface TenantSetupState {
  /** An application the tenant created itself, not one provisioned with it. */
  application: boolean;
  /** Anyone has ever signed in (as far back as the logs are kept). */
  login: boolean;
  branding: boolean;
}

interface Step {
  key: string;
  title: string;
  description: string;
  to: string;
  done: boolean;
}

const dismissKey = (tenantId: string) =>
  `authhero:getting-started-dismissed:${tenantId}`;

function readDismissed(tenantId: string | undefined): boolean {
  if (!tenantId) return false;
  try {
    return localStorage.getItem(dismissKey(tenantId)) === "1";
  } catch {
    return false;
  }
}

// What the server answers for a tenant with no branding of its own
// (`DEFAULT_BRANDING` in packages/authhero/src/constants/defaultBranding.ts).
// Keep in step with it, or a fresh tenant counts as branded.
const DEFAULT_LOGO_URL =
  "https://assets.sesamy.com/static/images/sesamy/logos/sesamy_logo_black.svg";
const DEFAULT_PRIMARY_COLOR = "#7d68f4";

export function isBrandingConfigured(branding: {
  logo_url?: string | null;
  colors?: { primary?: string | null } | null;
}): boolean {
  const logo = branding.logo_url;
  const primary = branding.colors?.primary?.toLowerCase();
  return (
    (!!logo && logo !== DEFAULT_LOGO_URL) ||
    (!!primary && primary !== DEFAULT_PRIMARY_COLOR)
  );
}

/**
 * An application the tenant set up itself. A new tenant comes with a
 * "Default App", which `default_client_id` points at, and with machine-to-
 * machine clients such as the "API Explorer Application"; neither counts.
 */
export function isOwnApplication(
  client: { client_id?: string; id?: unknown; app_type?: string | null },
  defaultClientId: string | undefined,
): boolean {
  const clientId = client.client_id ?? client.id;
  if (defaultClientId && clientId === defaultClientId) return false;
  return (
    client.app_type !== "non_interactive" &&
    client.app_type !== "resource_server"
  );
}

/**
 * Reads what the checklist needs beyond the dashboard's counts. The answer is
 * "hidden" for the control plane, which is the platform's own tenant rather
 * than one being set up, and when any of it cannot be read (most often a user
 * without the permission): the card would otherwise tell that user the tenant
 * is less set up than it is.
 */
function useTenantSetupState(): TenantSetupState | "hidden" | undefined {
  const dataProvider = useDataProvider();
  const [state, setState] = useState<TenantSetupState | "hidden">();

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      dataProvider.getOne("settings", { id: "settings" }),
      dataProvider.getList("clients", {
        pagination: { page: 1, perPage: 100 },
        sort: { field: "id", order: "ASC" },
        filter: {},
      }),
      dataProvider.getList("logs", {
        pagination: { page: 1, perPage: 1 },
        sort: { field: "date", order: "ASC" },
        filter: { type: LogTypes.SUCCESS_LOGIN },
      }),
      dataProvider.getOne("branding", { id: "branding" }),
    ]).then(([settings, clients, logins, branding]) => {
      if (cancelled) return;
      if (
        settings.status === "rejected" ||
        clients.status === "rejected" ||
        logins.status === "rejected" ||
        branding.status === "rejected"
      ) {
        setState("hidden");
        return;
      }
      const tenant = settings.value.data as {
        default_client_id?: string;
        is_control_plane?: boolean;
      };
      if (tenant.is_control_plane) {
        setState("hidden");
        return;
      }
      const defaultClientId = tenant.default_client_id;
      setState({
        application: clients.value.data.some((c) =>
          isOwnApplication(
            c as { client_id?: string; app_type?: string },
            defaultClientId,
          ),
        ),
        login: (logins.value.total ?? logins.value.data.length) > 0,
        branding: isBrandingConfigured(
          branding.value.data as Parameters<typeof isBrandingConfigured>[0],
        ),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [dataProvider]);

  return state;
}

export function gettingStartedSteps(
  progress: GettingStartedProgress,
  setup: TenantSetupState,
): Step[] {
  return [
    {
      key: "application",
      title: "Create an application",
      description: "Register the app your users will sign in to.",
      to: "/clients/create",
      done: setup.application,
    },
    {
      key: "login",
      title: "Try the login page",
      description: "Open an application and sign in through its login page.",
      to: "/clients",
      done: setup.login,
    },
    {
      key: "users",
      title: "Add your first user",
      description: "Create a user, or sign up through the login page.",
      to: "/users",
      done: (progress.users ?? 0) > 0,
    },
    {
      key: "branding",
      title: "Configure branding",
      description: "Add your logo and colors to the login page.",
      to: "/branding",
      done: setup.branding,
    },
  ];
}

/** One segment per step, filled in the step's place once it is done. */
function StepProgress({ steps }: { steps: Step[] }) {
  const done = steps.filter((step) => step.done).length;
  return (
    <div
      role="progressbar"
      aria-label="Setup progress"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${steps.length} steps done`}
      className="flex gap-1.5 pt-2"
    >
      {steps.map((step) => (
        <div
          key={step.key}
          data-done={step.done}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors duration-300",
            step.done ? "bg-brand" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

/**
 * A checklist for a new tenant, worked out from what the tenant already has,
 * so every user of the tenant sees the same progress and nothing is stored but
 * whether this browser dismissed it. It goes away once every step is done, or
 * when dismissed, and is not shown to a user who cannot read all of it.
 */
export function GettingStarted({
  progress,
  loading,
}: {
  progress: GettingStartedProgress;
  loading: boolean;
}) {
  const tenantId = useTenantId();
  const setup = useTenantSetupState();
  const [dismissed, setDismissed] = useState(() => readDismissed(tenantId));

  if (loading || setup === undefined || dismissed) return null;
  // What cannot be read is not shown as left to do. The user count comes from
  // the dashboard, which leaves it unset when its request failed.
  if (setup === "hidden" || progress.users === undefined) return null;
  const steps = gettingStartedSteps(progress, setup);
  const remaining = steps.filter((step) => !step.done).length;
  if (remaining === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    if (!tenantId) return;
    try {
      localStorage.setItem(dismissKey(tenantId), "1");
    } catch {
      // Storage may be unavailable; it stays dismissed for this visit.
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <CardTitle>Get started</CardTitle>
          <CardDescription>
            {remaining} of {steps.length} steps left to set up this tenant.
          </CardDescription>
          <StepProgress steps={steps} />
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          aria-label="Dismiss getting started"
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {steps.map((step) => (
            <li key={step.key} className="flex items-start gap-3">
              {step.done ? (
                <CheckCircle2
                  className="mt-0.5 h-5 w-5 shrink-0 text-green-600"
                  aria-label="Done"
                />
              ) : (
                <Circle
                  className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
                  aria-label="To do"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <Link
                  to={step.to}
                  className={
                    step.done
                      ? "text-muted-foreground line-through"
                      : "font-medium underline-offset-4 hover:underline"
                  }
                >
                  {step.title}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {step.description}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
