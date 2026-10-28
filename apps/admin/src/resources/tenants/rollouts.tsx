import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDataProvider, useNotify } from "ra-core";
import { ArrowLeft, Pause, Play, Plus, RefreshCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ALL_TENANTS,
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
  const [parentTenantIds, setParentTenantIds] = useState<string[]>([]);

  // A rollout can start from any tenant that has children.
  useEffect(() => {
    dataProvider
      .getList("tenants", {
        pagination: { page: 1, perPage: 500 },
        sort: { field: "id", order: "ASC" },
        filter: {},
      })
      .then(({ data }) => {
        const parents = new Set(
          data.flatMap((t) =>
            typeof t.parent_tenant_id === "string" ? [t.parent_tenant_id] : [],
          ),
        );
        setParentTenantIds([...parents].sort());
      })
      .catch(() => {
        // Without the list the select still offers "all tenants".
      });
  }, [dataProvider]);

  const parsedForm = toCreateRolloutInput(form);
  const validation = "error" in parsedForm ? parsedForm.error : null;

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

  /** Runs a request, then refreshes and shows the rollout it returned (or the open one). */
  const act = async (
    work: () => Promise<{ id?: string } | void>,
    done: string,
  ) => {
    setBusy(true);
    try {
      const result = await work();
      notify(done, { type: "info" });
      await refresh();
      const target = (result && result.id) || selectedId;
      if (target) await select(target);
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
      () => dataProvider.createRollout(parsed.input),
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
            <CardContent className="flex flex-col gap-6">
              <div className="grid gap-4 md:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollout-root">Root tenant</Label>
                  <Select
                    value={form.rootTenantId}
                    onValueChange={(v) => set("rootTenantId", v)}
                  >
                    <SelectTrigger id="rollout-root" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_TENANTS}>
                        Control plane (all tenants)
                      </SelectItem>
                      {parentTenantIds.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Starts here and syncs the synced tenants below it.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollout-canary">Canary tenants</Label>
                  <Input
                    id="rollout-canary"
                    type="number"
                    min={0}
                    step={1}
                    value={form.canary}
                    onChange={(e) => set("canary", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    How many tenants go first. A failure there stops the
                    rollout.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="rollout-threshold">
                    Pause above failures
                  </Label>
                  <div className="relative">
                    <Input
                      id="rollout-threshold"
                      type="number"
                      min={0}
                      max={100}
                      className="pr-8"
                      value={form.failureThreshold}
                      onChange={(e) => set("failureThreshold", e.target.value)}
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      %
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Pauses when more than this share of a wave fails.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label>Waves</Label>
                <p className="text-xs text-muted-foreground">
                  After the canary, each wave takes the tenants up to this share
                  of the fleet. The last wave takes whatever is left.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {form.waves.map((wave, index) => (
                    <div key={index} className="flex items-center gap-1">
                      <div className="relative">
                        <Input
                          aria-label={`Wave ${index + 1}`}
                          type="number"
                          min={1}
                          max={100}
                          className="w-24 pr-8"
                          value={wave}
                          onChange={(e) =>
                            set(
                              "waves",
                              form.waves.map((w, i) =>
                                i === index ? e.target.value : w,
                              ),
                            )
                          }
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                          %
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove wave ${index + 1}`}
                        disabled={form.waves.length <= 1}
                        onClick={() =>
                          set(
                            "waves",
                            form.waves.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => set("waves", [...form.waves, ""])}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add wave
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <Switch
                    id="rollout-dry"
                    checked={form.dryRun}
                    onCheckedChange={(v) => set("dryRun", v)}
                  />
                  <div>
                    <Label htmlFor="rollout-dry">Dry run</Label>
                    <p className="text-xs text-muted-foreground">
                      Plans and records the rollout without writing anything.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Switch
                    id="rollout-force"
                    checked={form.force}
                    onCheckedChange={(v) => set("force", v)}
                  />
                  <div>
                    <Label htmlFor="rollout-force">Force</Label>
                    <p className="text-xs text-muted-foreground">
                      Include tenants that are already up to date.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={start} disabled={busy || !!validation}>
                  Start rollout
                </Button>
                {validation && (
                  <p className="text-sm text-destructive">{validation}</p>
                )}
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
