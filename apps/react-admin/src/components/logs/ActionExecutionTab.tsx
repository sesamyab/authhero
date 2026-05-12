import { useEffect, useState } from "react";
import { useRecordContext } from "react-admin";
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import {
  authorizedHttpClient,
  createOrganizationHttpClient,
  isSingleTenantForDomain,
} from "../../authProvider";
import {
  buildUrlWithProtocol,
  formatDomain,
  getDomainFromStorage,
  getSelectedDomainFromStorage,
} from "../../utils/domainUtils";
import { getConfigValue } from "../../utils/runtimeConfig";
import { useTenantId } from "../../TenantContext";

type ExecutionResult = {
  action_name: string;
  error: { id: string; msg: string; url?: string } | null;
  started_at: string;
  ended_at: string;
};

type Execution = {
  id: string;
  trigger_id: string;
  status: string;
  results: ExecutionResult[];
  created_at: string;
  updated_at: string;
};

type Logs = Array<{
  action_name: string;
  lines: Array<{ level: string; message: string }>;
}>;

function getApiUrl(): string {
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

function durationMs(started_at: string, ended_at: string): number {
  return new Date(ended_at).getTime() - new Date(started_at).getTime();
}

export function ActionExecutionTab() {
  const record = useRecordContext();
  const tenantId = useTenantId();
  const executionId: string | undefined = record?.details?.execution_id;

  const [execution, setExecution] = useState<Execution | null>(null);
  const [logs, setLogs] = useState<Logs>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!executionId || !tenantId) return;

    setLoading(true);
    setError(null);

    const apiUrl = getApiUrl();
    const httpClient = getHttpClient(tenantId);
    const headers = new Headers({ "tenant-id": tenantId });

    Promise.all([
      httpClient(`${apiUrl}/api/v2/actions/executions/${executionId}`, {
        headers,
      }),
      httpClient(`${apiUrl}/api/v2/actions/executions/${executionId}/logs`, {
        headers,
      }).catch(() => ({ json: { logs: [] } })),
    ])
      .then(([execResp, logsResp]) => {
        setExecution(execResp.json as Execution);
        setLogs((logsResp.json as { logs: Logs }).logs);
      })
      .catch((err: unknown) => {
        const status =
          typeof err === "object" && err && "status" in err
            ? (err as { status: number }).status
            : undefined;
        setError(
          status === 404
            ? "Execution not found (may have been purged)"
            : `Failed to load execution${status ? ` (${status})` : ""}`,
        );
      })
      .finally(() => setLoading(false));
  }, [executionId, tenantId]);

  if (!executionId) {
    return (
      <Typography variant="body2" sx={{ mt: 1 }}>
        No execution recorded for this log entry.
      </Typography>
    );
  }

  if (loading) return <CircularProgress />;
  if (error) return <Typography color="error.main">{error}</Typography>;
  if (!execution) return null;

  return (
    <Stack spacing={2} sx={{ mt: 1 }}>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={0.5}>
            <Typography variant="subtitle2">Execution {execution.id}</Typography>
            <Typography variant="body2">
              Trigger: {execution.trigger_id}
            </Typography>
            <Typography variant="body2">
              Status: <strong>{execution.status}</strong>
            </Typography>
            <Typography variant="body2">
              Started: {new Date(execution.created_at).toLocaleString()}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      {execution.results.map((r, idx) => (
        <Card key={idx} variant="outlined">
          <CardContent>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{r.action_name}</Typography>
              <Typography variant="body2">
                Duration: {durationMs(r.started_at, r.ended_at)}ms
              </Typography>
              {r.error && (
                <Typography variant="body2" color="error.main">
                  {r.error.id}: {r.error.msg}
                </Typography>
              )}
              {logs
                .filter((l) => l.action_name === r.action_name)
                .flatMap((l) => l.lines).length > 0 && (
                <Box>
                  <Typography variant="body2">Console output:</Typography>
                  <Box
                    component="pre"
                    sx={{
                      bgcolor: "background.default",
                      p: 1,
                      borderRadius: 1,
                      overflow: "auto",
                      maxHeight: 240,
                      mt: 0.5,
                    }}
                  >
                    {logs
                      .filter((l) => l.action_name === r.action_name)
                      .flatMap((l) => l.lines)
                      .map((line) => `[${line.level}] ${line.message}`)
                      .join("\n")}
                  </Box>
                </Box>
              )}
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
}
