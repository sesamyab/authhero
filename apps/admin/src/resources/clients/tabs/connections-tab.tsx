import { useCallback, useEffect, useState } from "react";
import { useDataProvider, useNotify, useRecordContext } from "ra-core";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import {
  authorizedHttpClient,
  createOrganizationHttpClient,
  isSingleTenantForDomain,
} from "@/authProvider";
import { useTenantId } from "@/TenantContext";
import {
  buildUrlWithProtocol,
  formatDomain,
  getDomainFromStorage,
  getSelectedDomainFromStorage,
} from "@/utils/domainUtils";
import { getConfigValue } from "@/utils/runtimeConfig";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Strategy, isDatabaseConnectionStrategy } from "@/utils/Strategy";

interface Connection {
  id: string;
  name: string;
  strategy: string;
  show_as_button?: boolean;
  options?: { domain_aliases?: string[] };
}

// Mirrors the filter in packages/authhero/src/routes/universal-login/screens/identifier.ts:
// email/sms/database connections render as forms, and HRD-only connections
// (with domain_aliases) are routed by email domain unless show_as_button is set.
// Database connections are listed in their own section, see below.
const FORM_STRATEGIES = new Set<string>([Strategy.EMAIL, Strategy.SMS]);

function getHiddenButtonReason(c: Connection): string | null {
  if (
    FORM_STRATEGIES.has(c.strategy) ||
    isDatabaseConnectionStrategy(c.strategy)
  ) {
    return "Rendered as a form, not a button";
  }
  if (c.options?.domain_aliases?.length && c.show_as_button !== true) {
    return "HRD: routed by email domain";
  }
  return null;
}

function getApiBaseUrl(): string {
  const domains = getDomainFromStorage();
  const selectedDomain = getSelectedDomainFromStorage();
  const formattedSelectedDomain = formatDomain(selectedDomain);
  const domainConfig = domains.find(
    (d) => formatDomain(d.url) === formattedSelectedDomain,
  );

  let apiUrl: string;
  if (domainConfig?.restApiUrl) {
    apiUrl = buildUrlWithProtocol(domainConfig.restApiUrl);
  } else if (selectedDomain) {
    apiUrl = buildUrlWithProtocol(selectedDomain);
  } else {
    apiUrl = buildUrlWithProtocol(getConfigValue("apiUrl"));
  }
  return apiUrl.replace(/\/$/, "");
}

function getHttpClient(tenantId: string) {
  const formattedDomain = formatDomain(getSelectedDomainFromStorage());
  if (isSingleTenantForDomain(formattedDomain)) {
    return authorizedHttpClient;
  }
  return createOrganizationHttpClient(tenantId);
}

export function ConnectionsTab() {
  const record = useRecordContext<{ id?: string }>();
  const clientId = record?.id;
  const tenantId = useTenantId();
  const dataProvider = useDataProvider();
  const notify = useNotify();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState<Connection[]>([]);
  const [availableForAdd, setAvailableForAdd] = useState<Connection[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addSelectionId, setAddSelectionId] = useState<string>("");

  const loadConnections = useCallback(async () => {
    if (!clientId || !tenantId) return;
    setLoading(true);
    try {
      const baseUrl = getApiBaseUrl();
      const httpClient = getHttpClient(tenantId);
      const response = await httpClient(
        `${baseUrl}/api/v2/clients/${clientId}/connections`,
        {
          method: "GET",
          headers: { "tenant-id": tenantId },
        },
      );
      const body = response.json as {
        enabled_connections: Array<{
          connection_id: string;
          connection?: Connection;
        }>;
      };
      const enabledConns: Connection[] = body.enabled_connections
        .filter((ec) => ec.connection)
        .map((ec) => ({
          id: ec.connection_id,
          name: ec.connection!.name,
          strategy: ec.connection!.strategy,
          show_as_button: ec.connection!.show_as_button,
          options: ec.connection!.options,
        }));

      const { data: all } = await dataProvider.getList<Connection>(
        "connections",
        {
          pagination: { page: 1, perPage: 100 },
          sort: { field: "name", order: "ASC" },
          filter: {},
        },
      );
      const enabledIds = new Set(enabledConns.map((c) => c.id));
      setEnabled(enabledConns);
      setAvailableForAdd(all.filter((c) => !enabledIds.has(c.id)));
    } catch {
      notify("Error loading connections", { type: "error" });
    } finally {
      setLoading(false);
    }
  }, [clientId, tenantId, dataProvider, notify]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const patchConnections = async (ids: string[]): Promise<boolean> => {
    if (!clientId || !tenantId) return false;
    setSaving(true);
    try {
      const baseUrl = getApiBaseUrl();
      const httpClient = getHttpClient(tenantId);
      await httpClient(`${baseUrl}/api/v2/clients/${clientId}/connections`, {
        method: "PATCH",
        headers: {
          "tenant-id": tenantId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(ids),
      });
      return true;
    } catch (error) {
      // The http clients put the API's message in error.message.
      notify(
        error instanceof Error && error.message
          ? error.message
          : "Error updating connections",
        { type: "error" },
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    if (!addSelectionId) return;
    const next = [...enabled.map((c) => c.id), addSelectionId];
    const ok = await patchConnections(next);
    if (ok) {
      notify("Connection enabled", { type: "success" });
      setAddOpen(false);
      setAddSelectionId("");
      loadConnections();
    }
  };

  const handleRemove = async (id: string) => {
    const next = enabled.filter((c) => c.id !== id).map((c) => c.id);
    const ok = await patchConnections(next);
    if (ok) {
      notify("Connection disabled", { type: "success" });
      loadConnections();
    }
  };

  // Other connections keep their absolute positions; we only swap two
  // neighbors of one group (login buttons, or database connections) so that
  // group's order changes without disturbing the rest.
  const handleMove = async (
    group: (c: Connection) => boolean,
    groupIndex: number,
    dir: "up" | "down",
  ) => {
    const groupEntries = enabled
      .map((c, fullIndex) => ({ c, fullIndex }))
      .filter(({ c }) => group(c));
    const target = dir === "up" ? groupIndex - 1 : groupIndex + 1;
    if (target < 0 || target >= groupEntries.length) return;
    const a = groupEntries[groupIndex];
    const b = groupEntries[target];
    if (!a || !b) return;
    const next = [...enabled];
    next[a.fullIndex] = b.c;
    next[b.fullIndex] = a.c;
    setEnabled(next);
    const ok = await patchConnections(next.map((c) => c.id));
    if (ok) {
      notify("Connection order updated", { type: "success" });
    } else {
      loadConnections();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isVisible = (c: Connection) => getHiddenButtonReason(c) === null;
  const isDatabase = (c: Connection) =>
    isDatabaseConnectionStrategy(c.strategy);
  const visible = enabled.filter(isVisible);
  const databaseConnections = enabled.filter(isDatabase);
  const hidden = enabled.filter((c) => !isVisible(c) && !isDatabase(c));

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <section>
        <h3 className="text-base font-semibold">Visible on login screen</h3>
        <p className="text-sm text-muted-foreground mb-2">
          These connections appear as buttons on the login screen, in the order
          below.
        </p>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No connections will appear as buttons on the login screen.
          </p>
        ) : (
          <ul className="border rounded-md divide-y">
            {visible.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 p-2">
                <GripVertical className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Strategy: {c.strategy}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Move up"
                  disabled={i === 0 || saving}
                  onClick={() => handleMove(isVisible, i, "up")}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Move down"
                  disabled={i === visible.length - 1 || saving}
                  onClick={() => handleMove(isVisible, i, "down")}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove connection"
                  disabled={saving}
                  onClick={() => handleRemove(c.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {databaseConnections.length > 0 && (
        <section>
          <h3 className="text-base font-semibold">Database connections</h3>
          <p className="text-sm text-muted-foreground mb-2">
            Password login, signup and password reset use the first database
            connection, unless the login request names another one with the{" "}
            <code>connection</code> parameter.
          </p>
          <ul className="border rounded-md divide-y">
            {databaseConnections.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 p-2">
                <GripVertical className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {c.name}
                    {i === 0 && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Strategy: {c.strategy}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${c.name} up`}
                  disabled={i === 0 || saving}
                  onClick={() => handleMove(isDatabase, i, "up")}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${c.name} down`}
                  disabled={i === databaseConnections.length - 1 || saving}
                  onClick={() => handleMove(isDatabase, i, "down")}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove connection"
                  disabled={saving}
                  onClick={() => handleRemove(c.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hidden.length > 0 && (
        <section>
          <h3 className="text-base font-semibold">Hidden connections</h3>
          <p className="text-sm text-muted-foreground mb-2">
            These connections are enabled but won&apos;t show as buttons.
            Ordering them has no effect.
          </p>
          <ul className="border rounded-md divide-y bg-muted/30">
            {hidden.map((c) => {
              const reason = getHiddenButtonReason(c);
              return (
                <li key={c.id} className="flex items-center gap-2 p-2">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Strategy: {c.strategy}
                    </div>
                    {reason && (
                      <div className="text-xs italic text-muted-foreground">
                        {reason}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove connection"
                    disabled={saving}
                    onClick={() => handleRemove(c.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div>
        <Button
          type="button"
          onClick={() => setAddOpen(true)}
          disabled={availableForAdd.length === 0}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add connection
        </Button>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add connection</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Select a connection to enable for this client.
          </p>
          <Select value={addSelectionId} onValueChange={setAddSelectionId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a connection" />
            </SelectTrigger>
            <SelectContent>
              {availableForAdd.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} ({c.strategy})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setAddOpen(false);
                setAddSelectionId("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleAdd}
              disabled={!addSelectionId || saving}
            >
              Add connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
