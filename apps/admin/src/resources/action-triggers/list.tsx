import { useMemo, useState } from "react";
import {
  RecordContextProvider,
  useCreatePath,
  useDelete,
  useGetList,
  useNotify,
  useRefresh,
  useUpdate,
} from "ra-core";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ArrowDown, ArrowUp, Link2Off, Pencil, Plus } from "lucide-react";
import { InheritedBadge } from "@/components/inheritance/InheritedBadge";
import { isLockedInheritedRow } from "@/lib/syncedRows";
import {
  getBindingTypeChoices,
  getTriggerName,
  triggerChoices,
} from "../hooks/hookConstants";
import {
  bindingGroups,
  bindingLabel,
  bindingType,
  type ActionRecord,
  type TriggerBinding,
} from "./bindings";

interface TriggerSectionProps {
  triggerId: string;
  triggerName: string;
  hooks: TriggerBinding[];
  actions: ActionRecord[];
  forms: Array<{ id: string; name?: string }>;
}

function TriggerSection({
  triggerId,
  triggerName,
  hooks,
  actions,
  forms,
}: TriggerSectionProps) {
  const createPath = useCreatePath();
  const refresh = useRefresh();
  const notify = useNotify();
  const [update] = useUpdate();
  const [remove] = useDelete();
  const [busy, setBusy] = useState(false);
  const sortedHooks = useMemo(
    () => [...hooks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    [hooks],
  );
  const hookId = (h: TriggerBinding) => h.hook_id || h.id;
  const locked = (h: TriggerBinding) => isLockedInheritedRow(h) || !!h.enforce;

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      refresh();
    } catch (error) {
      notify(
        `Update failed: ${error instanceof Error ? error.message : String(error)}`,
        { type: "error" },
      );
    } finally {
      setBusy(false);
    }
  };

  const priorityChanges = (
    binding: TriggerBinding,
    direction: "up" | "down",
  ) => {
    const group = sortedHooks.filter(
      (hook) => bindingType(hook) === bindingType(binding),
    );
    const index = group.findIndex((hook) => hookId(hook) === hookId(binding));
    const target = index + (direction === "up" ? -1 : 1);
    if (index < 0 || target < 0 || target >= group.length) return [];
    [group[index], group[target]] = [group[target], group[index]];
    const base = Math.min(...group.map((hook) => hook.priority ?? 0));
    return group
      .map((hook, index) => ({
        hook,
        priority: base + group.length - 1 - index,
      }))
      .filter(({ hook, priority }) => (hook.priority ?? 0) !== priority);
  };

  const canMove = (binding: TriggerBinding, direction: "up" | "down") => {
    const changes = priorityChanges(binding, direction);
    return (
      !locked(binding) &&
      changes.length > 0 &&
      changes.every(({ hook }) => !locked(hook))
    );
  };

  const swapPriority = (binding: TriggerBinding, direction: "up" | "down") =>
    mutate(async () => {
      if (!canMove(binding, direction)) return;
      const changes = priorityChanges(binding, direction);
      const applied: TriggerBinding[] = [];
      try {
        for (const { hook, priority } of changes) {
          await update(
            "hooks",
            {
              id: hookId(hook),
              data: { priority },
              previousData: hook,
            },
            { returnPromise: true },
          );
          applied.push(hook);
        }
      } catch (error) {
        // Attempt every rollback even if one restoration fails.
        await Promise.allSettled(
          applied.reverse().map((hook) =>
            update(
              "hooks",
              {
                id: hookId(hook),
                data: { priority: hook.priority ?? 0 },
                previousData: hook,
              },
              { returnPromise: true },
            ),
          ),
        );
        throw error;
      }
    });

  const types = getBindingTypeChoices(triggerId);
  const source = encodeURIComponent(
    JSON.stringify({ trigger_id: triggerId, type: types[0]?.id }),
  );

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{triggerName}</CardTitle>
        {types.length > 0 && (
          <Button variant="outline" size="sm" asChild>
            <Link
              to={`${createPath({ resource: "hooks", type: "create" })}?source=${source}`}
              aria-label={`Add binding to ${triggerName}`}
            >
              <Plus className="h-4 w-4 mr-1" /> Add binding
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {hooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bindings configured.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {bindingGroups.map((group) => {
              const bindings = sortedHooks.filter(
                (hook) => (bindingType(hook) ?? "unknown") === group.id,
              );
              if (bindings.length === 0) return null;
              return (
                <section
                  key={group.id}
                  aria-label={`${triggerName} ${group.plural}`}
                >
                  <h3 className="text-sm font-medium mb-1">{group.plural}</h3>
                  <div className="divide-y">
                    {bindings.map((hook) => {
                      const name = bindingLabel(hook, actions, forms);
                      const editPath = createPath({
                        resource: "hooks",
                        type: "edit",
                        id: hookId(hook),
                      });
                      return (
                        <div
                          key={hookId(hook)}
                          className="flex flex-wrap items-center justify-between gap-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <Link
                              to={editPath}
                              className="text-primary underline break-all"
                            >
                              {name}
                            </Link>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mt-1">
                              <span>Priority {hook.priority ?? 0}</span>
                              <RecordContextProvider value={hook}>
                                <InheritedBadge />
                              </RecordContextProvider>
                              {hook.permission_required && (
                                <span>Requires {hook.permission_required}</span>
                              )}
                              {hook.code_id &&
                                actions.some(
                                  (action) => action.id === hook.code_id,
                                ) && (
                                  <Link
                                    to={createPath({
                                      resource: "actions",
                                      type: "edit",
                                      id: hook.code_id,
                                    })}
                                    className="underline"
                                  >
                                    Edit action code
                                  </Link>
                                )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Switch
                              checked={hook.enabled}
                              disabled={busy || locked(hook)}
                              aria-label={`Enable ${name}`}
                              onCheckedChange={() =>
                                mutate(() =>
                                  update("hooks", {
                                    id: hookId(hook),
                                    data: { enabled: !hook.enabled },
                                    previousData: hook,
                                  }),
                                )
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy || !canMove(hook, "up")}
                              aria-label={`Move ${name} up`}
                              onClick={() => swapPriority(hook, "up")}
                            >
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy || !canMove(hook, "down")}
                              aria-label={`Move ${name} down`}
                              onClick={() => swapPriority(hook, "down")}
                            >
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" asChild>
                              <Link
                                to={editPath}
                                aria-label={`Edit ${name} binding`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Link>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy || locked(hook)}
                              aria-label={`Remove ${name} binding`}
                              onClick={() =>
                                mutate(() =>
                                  remove("hooks", {
                                    id: hookId(hook),
                                    previousData: hook,
                                  }),
                                )
                              }
                            >
                              <Link2Off className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ActionTriggersList() {
  const [perPage, setPerPage] = useState(200);
  const hooks = useGetList<TriggerBinding>("hooks", {
    pagination: { page: 1, perPage },
    sort: { field: "priority", order: "DESC" },
  });
  const actions = useGetList<ActionRecord>("actions", {
    pagination: { page: 1, perPage },
    sort: { field: "name", order: "ASC" },
  });
  const forms = useGetList<{ id: string; name?: string }>("forms", {
    pagination: { page: 1, perPage },
    sort: { field: "name", order: "ASC" },
  });
  const refresh = useRefresh();
  const triggers = useMemo(() => {
    const knownIds = new Set(triggerChoices.map((trigger) => trigger.id));
    const additional = [
      ...new Set((hooks.data ?? []).map((hook) => hook.trigger_id)),
    ]
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id, name: getTriggerName(id) }));
    return [...triggerChoices, ...additional];
  }, [hooks.data]);

  if (hooks.isPending || actions.isPending || forms.isPending)
    return <div className="p-4">Loading…</div>;
  if (hooks.error)
    return (
      <div className="p-4" role="alert">
        Unable to load trigger bindings.{" "}
        <Button variant="outline" onClick={() => refresh()}>
          Retry
        </Button>
      </div>
    );
  const hasMore = [hooks, actions, forms].some(
    (result) => (result.total ?? 0) > (result.data?.length ?? 0),
  );

  return (
    <div className="p-4 flex flex-col gap-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Triggers</h2>
        <p className="text-sm text-muted-foreground">
          Manage the actions, webhooks, forms, templates, and pages attached to
          each event.
        </p>
        <p className="text-sm text-muted-foreground">
          Binding types run in separate phases. Higher priority runs first
          within each type.
        </p>
      </div>
      {(actions.error || forms.error) && (
        <p role="status" className="text-sm text-muted-foreground">
          Some resource names could not be loaded. You can still manage their
          bindings.
        </p>
      )}
      {hasMore && (
        <Button
          variant="outline"
          onClick={() => setPerPage((count) => count + 200)}
        >
          Load more bindings and resources
        </Button>
      )}
      {triggers.map((trigger) => (
        <TriggerSection
          key={trigger.id}
          triggerId={trigger.id}
          triggerName={trigger.name}
          hooks={(hooks.data ?? []).filter(
            (hook) => hook.trigger_id === trigger.id,
          )}
          actions={actions.data ?? []}
          forms={forms.data ?? []}
        />
      ))}
    </div>
  );
}
