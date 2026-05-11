import { useMemo, useState } from "react";
import {
  Title,
  useCreate,
  useDelete,
  useGetList,
  useNotify,
  useRefresh,
  useUpdate,
  Link,
} from "react-admin";
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Switch,
  IconButton,
  Tooltip,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List as MuiList,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Stack,
} from "@mui/material";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import AddIcon from "@mui/icons-material/Add";
import { codeHookTriggerChoices } from "../hooks/hookConstants";

// Auth0 uses "post-login" in supported_triggers; internally we store "post-user-login"
// on hook records. All other code triggers share the same id on both sides.
const ACTION_TO_HOOK_TRIGGER: Record<string, string> = {
  "post-login": "post-user-login",
};

function actionSupportsTrigger(
  action: Record<string, any>,
  hookTriggerId: string,
): boolean {
  const triggers: Array<{ id?: string }> = action.supported_triggers || [];
  return triggers.some((t) => {
    if (!t?.id) return false;
    const mapped = ACTION_TO_HOOK_TRIGGER[t.id] || t.id;
    return mapped === hookTriggerId;
  });
}

interface CodeHook {
  hook_id: string;
  id?: string;
  trigger_id: string;
  code_id: string;
  enabled: boolean;
  priority?: number;
}

interface ActionRecord {
  id: string;
  name: string;
  supported_triggers?: Array<{ id?: string }>;
}

interface TriggerSectionProps {
  triggerId: string;
  triggerName: string;
  hooks: CodeHook[];
  actions: ActionRecord[];
}

function TriggerSection({
  triggerId,
  triggerName,
  hooks,
  actions,
}: TriggerSectionProps) {
  const refresh = useRefresh();
  const notify = useNotify();
  const [update] = useUpdate();
  const [remove] = useDelete();
  const [create] = useCreate();
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachActionId, setAttachActionId] = useState<string>("");

  const sortedHooks = useMemo(
    () =>
      [...hooks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    [hooks],
  );

  const actionsById = useMemo(() => {
    const map: Record<string, ActionRecord> = {};
    for (const a of actions) map[a.id] = a;
    return map;
  }, [actions]);

  const availableActions = useMemo(
    () =>
      actions.filter(
        (a) =>
          actionSupportsTrigger(a, triggerId) &&
          !hooks.some((h) => h.code_id === a.id),
      ),
    [actions, hooks, triggerId],
  );

  const hookId = (h: CodeHook) => h.hook_id || h.id || "";

  const swapPriority = async (i: number, j: number) => {
    const a = sortedHooks[i];
    const b = sortedHooks[j];
    if (!a || !b) return;
    const aPrio = a.priority ?? 0;
    const bPrio = b.priority ?? 0;
    // If both share the same priority, bump one slot so they actually swap.
    const newAPrio = bPrio === aPrio ? aPrio + 1 : bPrio;
    const newBPrio = aPrio === bPrio ? aPrio - 1 : aPrio;
    try {
      await Promise.all([
        update("hooks", {
          id: hookId(a),
          data: { priority: newAPrio },
          previousData: a,
        }),
        update("hooks", {
          id: hookId(b),
          data: { priority: newBPrio },
          previousData: b,
        }),
      ]);
      refresh();
    } catch (err: any) {
      notify(`Reorder failed: ${err.message}`, { type: "error" });
    }
  };

  const toggleEnabled = async (h: CodeHook) => {
    try {
      await update("hooks", {
        id: hookId(h),
        data: { enabled: !h.enabled },
        previousData: h,
      });
      refresh();
    } catch (err: any) {
      notify(`Update failed: ${err.message}`, { type: "error" });
    }
  };

  const unbind = async (h: CodeHook) => {
    try {
      await remove("hooks", { id: hookId(h), previousData: h });
      refresh();
    } catch (err: any) {
      notify(`Unbind failed: ${err.message}`, { type: "error" });
    }
  };

  const attach = async () => {
    if (!attachActionId) return;
    const maxPriority = sortedHooks.reduce(
      (max, h) => Math.max(max, h.priority ?? 0),
      0,
    );
    try {
      await create("hooks", {
        data: {
          trigger_id: triggerId,
          code_id: attachActionId,
          enabled: true,
          priority: maxPriority + 1,
        },
      });
      setAttachOpen(false);
      setAttachActionId("");
      refresh();
    } catch (err: any) {
      notify(`Attach failed: ${err.message}`, { type: "error" });
    }
  };

  return (
    <Card sx={{ mb: 3 }}>
      <CardHeader
        title={triggerName}
        subheader={triggerId}
        action={
          <Button
            startIcon={<AddIcon />}
            onClick={() => setAttachOpen(true)}
            disabled={availableActions.length === 0}
          >
            Attach action
          </Button>
        }
      />
      <CardContent>
        {sortedHooks.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No actions attached. Higher-priority actions run first.
          </Typography>
        ) : (
          <MuiList disablePadding>
            {sortedHooks.map((h, idx) => {
              const action = actionsById[h.code_id];
              return (
                <ListItem
                  key={hookId(h)}
                  divider={idx < sortedHooks.length - 1}
                >
                  <ListItemText
                    primary={
                      action ? (
                        <Link to={`/actions/${action.id}`}>{action.name}</Link>
                      ) : (
                        <em>Missing action {h.code_id}</em>
                      )
                    }
                    secondary={`priority ${h.priority ?? 0} · ${h.code_id}`}
                  />
                  <ListItemSecondaryAction>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Tooltip title={h.enabled ? "Disable" : "Enable"}>
                        <Switch
                          size="small"
                          checked={h.enabled}
                          onChange={() => toggleEnabled(h)}
                        />
                      </Tooltip>
                      <Tooltip title="Move up">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => swapPriority(idx, idx - 1)}
                            disabled={idx === 0}
                          >
                            <ArrowUpwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Move down">
                        <span>
                          <IconButton
                            size="small"
                            onClick={() => swapPriority(idx, idx + 1)}
                            disabled={idx === sortedHooks.length - 1}
                          >
                            <ArrowDownwardIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Unbind">
                        <IconButton size="small" onClick={() => unbind(h)}>
                          <LinkOffIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </ListItemSecondaryAction>
                </ListItem>
              );
            })}
          </MuiList>
        )}
      </CardContent>

      <Dialog
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Attach action to {triggerName}</DialogTitle>
        <DialogContent>
          <FormControl fullWidth sx={{ mt: 1 }}>
            <InputLabel id={`attach-${triggerId}`}>Action</InputLabel>
            <Select
              labelId={`attach-${triggerId}`}
              label="Action"
              value={attachActionId}
              onChange={(e) => setAttachActionId(e.target.value)}
            >
              {availableActions.map((a) => (
                <MenuItem key={a.id} value={a.id}>
                  {a.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAttachOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={attach}
            disabled={!attachActionId}
          >
            Attach
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

export function ActionTriggersList() {
  const { data: hookData, isLoading: hooksLoading } = useGetList("hooks", {
    pagination: { page: 1, perPage: 200 },
    sort: { field: "priority", order: "DESC" },
  });
  const { data: actionData, isLoading: actionsLoading } = useGetList(
    "actions",
    {
      pagination: { page: 1, perPage: 200 },
      sort: { field: "name", order: "ASC" },
    },
  );

  const codeHooks: CodeHook[] = useMemo(
    () =>
      (hookData ?? []).filter(
        (h: any): h is CodeHook =>
          typeof h?.code_id === "string" && h.code_id.length > 0,
      ),
    [hookData],
  );
  const actions: ActionRecord[] = useMemo(
    () => (actionData ?? []) as ActionRecord[],
    [actionData],
  );

  if (hooksLoading || actionsLoading) {
    return (
      <Box sx={{ p: 2 }}>
        <Title title="Triggers" />
        <Typography>Loading…</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2 }}>
      <Title title="Triggers" />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Attach deployed actions to triggers. Higher-priority actions run first.
      </Typography>
      {codeHookTriggerChoices.map((t) => (
        <TriggerSection
          key={t.id}
          triggerId={t.id}
          triggerName={t.name}
          hooks={codeHooks.filter((h) => h.trigger_id === t.id)}
          actions={actions}
        />
      ))}
    </Box>
  );
}
