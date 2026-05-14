import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import RestoreIcon from "@mui/icons-material/Restore";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { useNotify, useRecordContext, useRefresh, Confirm } from "react-admin";
import { createManagementClient } from "../../authProvider";
import { resolveApiBase } from "../../dataProvider";
import { getConfigValue } from "../../utils/runtimeConfig";
import { useTenantId } from "../../TenantContext";

type ActionVersion = {
  id: string;
  number: number;
  code: string;
  runtime?: string;
  deployed: boolean;
  status?: string;
  created_at?: string;
  updated_at?: string;
};

function isActionVersion(value: unknown): value is ActionVersion {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.number === "number" &&
    typeof v.code === "string" &&
    typeof v.deployed === "boolean"
  );
}

export function ActionVersionsPanel() {
  const record = useRecordContext();
  const tenantId = useTenantId();
  const notify = useNotify();
  const refresh = useRefresh();

  const [versions, setVersions] = useState<ActionVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingRollback, setPendingRollback] = useState<ActionVersion | null>(
    null,
  );
  const [rolling, setRolling] = useState(false);

  const actionId = record?.id ? String(record.id) : undefined;

  const loadVersions = useCallback(async () => {
    if (!actionId) return;
    setLoading(true);
    try {
      const domain = getConfigValue("domain") || "";
      const apiUrl = resolveApiBase(domain);
      const client = await createManagementClient(apiUrl, tenantId, domain);
      const page = await client.actions.versions.list(actionId);
      const items: unknown[] = page.data;
      setVersions(items.filter(isActionVersion));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(`Failed to load versions: ${message}`, { type: "error" });
    } finally {
      setLoading(false);
    }
  }, [actionId, tenantId, notify]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  const handleRollback = async () => {
    if (!actionId || !pendingRollback) return;
    setRolling(true);
    try {
      const domain = getConfigValue("domain") || "";
      const apiUrl = resolveApiBase(domain);
      const client = await createManagementClient(apiUrl, tenantId, domain);
      await client.actions.versions.deploy(actionId, pendingRollback.id);
      notify(`Rolled back to version ${pendingRollback.number}`, {
        type: "success",
      });
      setPendingRollback(null);
      await loadVersions();
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notify(`Rollback failed: ${message}`, { type: "error" });
    } finally {
      setRolling(false);
    }
  };

  if (!actionId) return null;

  return (
    <Stack spacing={2} sx={{ width: "100%" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="body2" sx={{ flex: 1 }}>
          Every save and deploy creates a new version. Pick an earlier version
          to roll back to its code, runtime, secrets and dependencies.
        </Typography>
        <Button
          size="small"
          startIcon={<RefreshIcon />}
          onClick={loadVersions}
          disabled={loading}
        >
          Refresh
        </Button>
      </Box>

      {loading && versions.length === 0 ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress size={24} />
        </Box>
      ) : versions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No versions yet.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 32 }} />
              <TableCell>Version</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {versions.map((v) => {
              const expanded = expandedId === v.id;
              return (
                <Fragment key={v.id}>
                  <TableRow hover>
                    <TableCell>
                      <IconButton
                        size="small"
                        onClick={() => setExpandedId(expanded ? null : v.id)}
                        aria-label={expanded ? "Collapse" : "Expand"}
                      >
                        {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                    </TableCell>
                    <TableCell>v{v.number}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        {v.deployed && (
                          <Chip label="Deployed" size="small" color="success" />
                        )}
                        {v.status && (
                          <Chip
                            label={v.status}
                            size="small"
                            variant="outlined"
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {v.created_at
                        ? new Date(v.created_at).toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        startIcon={<RestoreIcon />}
                        onClick={() => setPendingRollback(v)}
                        disabled={v.deployed}
                      >
                        Roll back
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expanded && (
                    <TableRow>
                      <TableCell colSpan={5} sx={{ bgcolor: "action.hover" }}>
                        <Box
                          component="pre"
                          sx={{
                            m: 0,
                            p: 1,
                            fontFamily: "monospace",
                            fontSize: 12,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            maxHeight: 360,
                            overflow: "auto",
                          }}
                        >
                          {v.code}
                        </Box>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Confirm
        isOpen={pendingRollback !== null}
        loading={rolling}
        title={
          pendingRollback
            ? `Roll back to version ${pendingRollback.number}?`
            : ""
        }
        content="This will replace the action's current code, runtime, secrets and dependencies with this version, redeploy it, and record a new version capturing the rollback."
        onConfirm={handleRollback}
        onClose={() => setPendingRollback(null)}
      />
    </Stack>
  );
}
