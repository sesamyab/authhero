import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDataProvider, useNotify } from "ra-core";
import { ArrowLeft, Pause, Play, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AuthHeroDataProvider,
  RolloutRecord,
  RolloutSummary,
} from "@/auth0DataProvider";
import {
  DEFAULT_ROLLOUT_FORM,
  toCreateRolloutInput,
  type RolloutFormValues,
} from "./rolloutForm";

const STATUS_VARIANT: Record<
  RolloutRecord["status"],
  "default" | "outline" | "secondary" | "destructive"
> = {
  pending: "secondary",
  canary: "secondary",
  rolling: "secondary",
  paused: "destructive",
  done: "outline",
  failed: "destructive",
};

const OPEN: RolloutRecord["status"][] = ["pending", "canary", "rolling"];
const POLL_INTERVAL_MS = 5000;

function formatTimestamp(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : fallback;
}

type DetailState = RolloutRecord & { summary: RolloutSummary };

/**
 * Control-plane view of fleet rollouts (issue #1499): start a staged sync of
 * every synced tenant, follow it wave by wave, and pause or resume it when the
 * health gate trips. Polls while a rollout is open.
 */
export function Rollouts() {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();

  const [rollouts, setRollouts] = useState<RolloutRecord[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DetailState | null>(null);
  const [form, setForm] = useState<RolloutFormValues>(DEFAULT_ROLLOUT_FORM);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { rollouts: rows } = await dataProvider.listRollouts({
        perPage: 50,
      });
      setRollouts(rows);
      setAvailable(true);
    } catch (error) {
      const status = (error as { status?: number } | undefined)?.status;
      if (status === 404 || status === 501) setAvailable(false);
      else
        notify(errorMessage(error, "Could not load rollouts"), {
          type: "error",
        });
    } finally {
      setLoading(false);
    }
  }, [dataProvider, notify]);

  const select = useCallback(
    async (id: string) => {
      try {
        setSelected(await dataProvider.getRollout(id));
      } catch (error) {
        notify(errorMessage(error, "Could not load the rollout"), {
          type: "error",
        });
      }
    },
    [dataProvider, notify],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const anyOpen =
    rollouts.some((r) => OPEN.includes(r.status)) ||
    (selected ? OPEN.includes(selected.status) : false);
  const selectedId = selected?.id;
  useEffect(() => {
    if (!anyOpen) return;
    const timer = setInterval(() => {
      void refresh();
      if (selectedId) void select(selectedId);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [anyOpen, refresh, select, selectedId]);

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await work();
      notify(done, { type: "info" });
      await refresh();
      if (selectedId) await select(selectedId);
    } catch (error) {
      notify(errorMessage(error, "The request failed"), { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const parsed = toCreateRolloutInput(form);
    if ("error" in parsed) {
      notify(parsed.error, { type: "error" });
      return;
    }
    await act(
      async () => {
        const created = await dataProvider.createRollout(parsed.input);
        await select(created.id);
      },
      form.dryRun ? "Dry run recorded" : "Rollout started",
    );
  };

  const set = <K extends keyof RolloutFormValues>(
    key: K,
    value: RolloutFormValues[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

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

      {!available ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Fleet rollouts aren&apos;t enabled for this deployment. The control
            plane needs the rollouts and tenant-operations adapters configured.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>New rollout</CardTitle>
              <CardDescription>
                Syncs every synced tenant below the root: the canary first, then
                the waves, pausing if a wave fails.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 md:grid-cols-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollout-root">Root tenant</Label>
                  <Input
                    id="rollout-root"
                    placeholder="control plane"
                    value={form.rootTenantId}
                    onChange={(e) => set("rootTenantId", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollout-canary">Canary tenants</Label>
                  <Input
                    id="rollout-canary"
                    value={form.canary}
                    onChange={(e) => set("canary", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollout-waves">Waves (% of tenants)</Label>
                  <Input
                    id="rollout-waves"
                    value={form.waves}
                    onChange={(e) => set("waves", e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollout-threshold">
                    Pause above failures (%)
                  </Label>
                  <Input
                    id="rollout-threshold"
                    value={form.failureThreshold}
                    onChange={(e) => set("failureThreshold", e.target.value)}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="rollout-dry"
                    checked={form.dryRun}
                    onCheckedChange={(v) => set("dryRun", v === true)}
                  />
                  <Label htmlFor="rollout-dry">Dry run (write nothing)</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="rollout-force"
                    checked={form.force}
                    onCheckedChange={(v) => set("force", v === true)}
                  />
                  <Label htmlFor="rollout-force">
                    Force (include tenants already up to date)
                  </Label>
                </div>
                <Button onClick={start} disabled={busy}>
                  Start rollout
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Rollouts</CardTitle>
              <Button variant="outline" size="sm" onClick={refresh}>
                <RefreshCw className="h-4 w-4 mr-1" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="py-4 text-sm text-muted-foreground">Loading...</p>
              ) : rollouts.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No rollouts yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Started</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Initiated by</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rollouts.map((rollout) => (
                      <TableRow
                        key={rollout.id}
                        className="cursor-pointer"
                        onClick={() => void select(rollout.id)}
                      >
                        <TableCell>
                          {formatTimestamp(rollout.created_at)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[rollout.status]}>
                            {rollout.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {String(rollout.config?.trigger ?? "manual")}
                        </TableCell>
                        <TableCell>{rollout.initiated_by ?? "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {selected && (
            <Card data-testid="rollout-detail">
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <CardTitle className="flex items-center gap-2">
                    Rollout
                    <Badge variant={STATUS_VARIANT[selected.status]}>
                      {selected.status}
                    </Badge>
                  </CardTitle>
                  <CardDescription>
                    {selected.paused_reason ??
                      `${selected.summary.total} tenant(s)`}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  {OPEN.includes(selected.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => dataProvider.pauseRollout(selected.id),
                          "Rollout paused",
                        )
                      }
                    >
                      <Pause className="h-4 w-4 mr-1" />
                      Pause
                    </Button>
                  )}
                  {selected.status === "paused" && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        act(
                          () => dataProvider.resumeRollout(selected.id),
                          "Rollout resumed",
                        )
                      }
                      title="Accept the failures so far and continue with the next wave"
                    >
                      <Play className="h-4 w-4 mr-1" />
                      Resume
                    </Button>
                  )}
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/tenants">Tenants</Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Wave</TableHead>
                      <TableHead>Tenants</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selected.summary.by_wave.map((wave) => (
                      <TableRow key={wave.wave}>
                        <TableCell>
                          {wave.wave === 0 &&
                          Number(selected.config?.canary) > 0
                            ? "canary"
                            : `wave ${wave.wave}`}
                        </TableCell>
                        <TableCell>{wave.total}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {Object.entries(wave.by_status ?? {})
                            .map(([status, n]) => `${n} ${status}`)
                            .join(", ")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
