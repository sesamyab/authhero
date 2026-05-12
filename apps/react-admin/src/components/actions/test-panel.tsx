import { useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import { useNotify, useRecordContext } from "react-admin";
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

// Example event payloads per trigger. Auth0-shape so action code written
// against Auth0 docs validates against these out of the box.
const EXAMPLE_EVENTS: Record<string, Record<string, unknown>> = {
  "post-login": {
    user: {
      user_id: "auth0|example",
      email: "test@example.com",
      email_verified: true,
      name: "Test User",
    },
    client: { client_id: "test-client", name: "Test Client" },
    connection: {
      id: "con_test",
      name: "Username-Password-Authentication",
      strategy: "auth0",
    },
    request: {
      ip: "127.0.0.1",
      method: "GET",
      url: "https://example.com/authorize",
    },
    transaction: { redirect_uri: "https://example.com/callback" },
    tenant: { id: "test-tenant" },
    stats: { logins_count: 1 },
  },
  "credentials-exchange": {
    user: { user_id: "auth0|example", email: "test@example.com" },
    client: { client_id: "test-client", name: "Test Client" },
    scope: "openid profile email",
    grant_type: "authorization_code",
    request: { ip: "127.0.0.1", method: "POST", url: "/oauth/token" },
  },
  "pre-user-registration": {
    user: {
      email: "newuser@example.com",
      tenant: "test-tenant",
      username: "newuser",
      app_metadata: {},
      user_metadata: {},
    },
    request: { ip: "127.0.0.1", method: "POST", url: "/dbconnections/signup" },
  },
  "post-user-registration": {
    user: {
      user_id: "auth0|newuser",
      email: "newuser@example.com",
      email_verified: false,
    },
    request: { ip: "127.0.0.1", method: "POST", url: "/dbconnections/signup" },
  },
};

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

type TestResult = {
  success: boolean;
  error?: string;
  duration_ms: number;
  api_calls: Array<{ method: string; args: unknown[] }>;
  logs: Array<{ level: string; message: string }>;
};

export function ActionTestPanel() {
  const record = useRecordContext();
  const tenantId = useTenantId();
  const notify = useNotify();

  const initialTrigger: string =
    (record?.supported_triggers as Array<{ id: string }> | undefined)?.[0]
      ?.id ?? "post-login";

  const [trigger, setTrigger] = useState<string>(initialTrigger);
  const [payload, setPayload] = useState<string>(() =>
    JSON.stringify(EXAMPLE_EVENTS[initialTrigger] ?? {}, null, 2),
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const handleTriggerChange = (newTrigger: string) => {
    setTrigger(newTrigger);
    setPayload(JSON.stringify(EXAMPLE_EVENTS[newTrigger] ?? {}, null, 2));
  };

  const handleRun = async () => {
    if (!record?.id) return;
    let parsedEvent: unknown;
    try {
      parsedEvent = JSON.parse(payload);
    } catch (err) {
      notify(`Invalid JSON: ${(err as Error).message}`, { type: "error" });
      return;
    }

    setRunning(true);
    setResult(null);
    try {
      const apiUrl = getApiUrl();
      const httpClient = getHttpClient(tenantId || "");
      const response = await httpClient(
        `${apiUrl}/api/v2/actions/actions/${record.id}/test`,
        {
          method: "POST",
          body: JSON.stringify({ trigger_id: trigger, event: parsedEvent }),
          headers: new Headers({
            "tenant-id": tenantId || "",
            "content-type": "application/json",
          }),
        },
      );
      setResult(response.json as TestResult);
    } catch (err: unknown) {
      const status =
        typeof err === "object" && err && "status" in err
          ? (err as { status: number }).status
          : undefined;
      const body =
        typeof err === "object" && err && "body" in err
          ? (err as { body: string }).body
          : undefined;
      notify(`Test run failed${status ? ` (${status})` : ""}: ${body ?? ""}`, {
        type: "error",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Accordion sx={{ mt: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1">Test action</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <TextField
            select
            label="Trigger"
            value={trigger}
            onChange={(e) => handleTriggerChange(e.target.value)}
            fullWidth
          >
            {Object.keys(EXAMPLE_EVENTS).map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Event payload (JSON)"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            multiline
            minRows={10}
            fullWidth
            sx={{ "& .MuiInputBase-input": { fontFamily: "monospace" } }}
          />
          <Box>
            <Button
              variant="contained"
              startIcon={
                running ? <CircularProgress size={16} /> : <PlayArrowIcon />
              }
              onClick={handleRun}
              disabled={running}
            >
              Run
            </Button>
          </Box>
          {result && (
            <Stack spacing={1}>
              <Typography
                variant="subtitle2"
                color={result.success ? "success.main" : "error.main"}
              >
                {result.success ? "Success" : "Failed"} in {result.duration_ms}
                ms
              </Typography>
              {result.error && (
                <Typography variant="body2" color="error.main">
                  {result.error}
                </Typography>
              )}
              {result.api_calls.length > 0 && (
                <Box>
                  <Typography variant="subtitle2">API calls</Typography>
                  <Box
                    component="pre"
                    sx={{
                      bgcolor: "background.default",
                      p: 1,
                      borderRadius: 1,
                      overflow: "auto",
                      maxHeight: 240,
                    }}
                  >
                    {result.api_calls
                      .map(
                        (c) =>
                          `${c.method}(${c.args
                            .map((a) => JSON.stringify(a))
                            .join(", ")})`,
                      )
                      .join("\n")}
                  </Box>
                </Box>
              )}
              {result.logs.length > 0 && (
                <Box>
                  <Typography variant="subtitle2">Console output</Typography>
                  <Box
                    component="pre"
                    sx={{
                      bgcolor: "background.default",
                      p: 1,
                      borderRadius: 1,
                      overflow: "auto",
                      maxHeight: 240,
                    }}
                  >
                    {result.logs
                      .map((l) => `[${l.level}] ${l.message}`)
                      .join("\n")}
                  </Box>
                </Box>
              )}
            </Stack>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
