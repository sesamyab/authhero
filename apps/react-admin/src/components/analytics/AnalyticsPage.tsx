import { useMemo, useState } from "react";
import {
  Box,
  Typography,
  Paper,
  Grid,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  MenuItem,
  Alert,
  CircularProgress,
  Chip,
  Stack,
  Button,
} from "@mui/material";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
} from "recharts";
import { format, subDays, parseISO } from "date-fns";
import {
  AnalyticsGroupBy,
  AnalyticsInterval,
  AnalyticsResource,
  useAnalyticsQuery,
} from "./useAnalyticsQuery";

const RESOURCES: Array<{
  value: AnalyticsResource;
  label: string;
  metric: string;
  dims: AnalyticsGroupBy[];
}> = [
  {
    value: "active-users",
    label: "Active Users",
    metric: "active_users",
    dims: ["time", "connection", "client_id", "user_type"],
  },
  {
    value: "logins",
    label: "Logins",
    metric: "logins",
    dims: ["time", "connection", "client_id", "user_type", "event"],
  },
  {
    value: "signups",
    label: "Signups",
    metric: "signups",
    dims: ["time", "connection", "client_id", "user_type", "event"],
  },
  {
    value: "refresh-tokens",
    label: "Refresh Tokens",
    metric: "refresh_tokens",
    dims: ["time", "client_id", "event"],
  },
  {
    value: "sessions",
    label: "Sessions",
    metric: "sessions",
    dims: ["time", "client_id"],
  },
];

const PRESETS: Array<{ label: string; days: number; interval: AnalyticsInterval }> = [
  { label: "Last 24h", days: 1, interval: "hour" },
  { label: "Last 7d", days: 7, interval: "day" },
  { label: "Last 30d", days: 30, interval: "day" },
  { label: "Last 90d", days: 90, interval: "day" },
];

const CHART_COLORS = [
  "#1976d2",
  "#d32f2f",
  "#2e7d32",
  "#9c27b0",
  "#ed6c02",
  "#0288d1",
  "#5d4037",
];

function pivotForTimeSeries(
  rows: Array<Record<string, unknown>>,
  metric: string,
  dimColumns: string[],
): { rows: Array<Record<string, unknown>>; seriesKeys: string[] } {
  const timeKey = "time";
  const groupKeys = dimColumns.filter((c) => c !== timeKey);

  if (groupKeys.length === 0) {
    return {
      rows: rows.map((r) => ({ time: r[timeKey], [metric]: r[metric] })),
      seriesKeys: [metric],
    };
  }

  const byTime = new Map<string, Record<string, unknown>>();
  const seriesSet = new Set<string>();
  for (const r of rows) {
    const t = String(r[timeKey]);
    const series = groupKeys.map((k) => String(r[k] ?? "—")).join(" · ");
    seriesSet.add(series);
    if (!byTime.has(t)) byTime.set(t, { time: t });
    byTime.get(t)![series] = r[metric];
  }
  return {
    rows: [...byTime.values()].sort((a, b) =>
      String(a.time).localeCompare(String(b.time)),
    ),
    seriesKeys: [...seriesSet],
  };
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]!);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function AnalyticsPage() {
  const [resource, setResource] = useState<AnalyticsResource>("active-users");
  const [presetIndex, setPresetIndex] = useState<number>(2);
  const [interval, setInterval] = useState<AnalyticsInterval>(
    PRESETS[2]!.interval,
  );
  const [groupBy, setGroupBy] = useState<AnalyticsGroupBy[]>(["time"]);
  const [connectionFilter, setConnectionFilter] = useState<string>("");
  const [clientFilter, setClientFilter] = useState<string>("");

  const resourceMeta = RESOURCES.find((r) => r.value === resource)!;

  const { from, to } = useMemo(() => {
    const preset = PRESETS[presetIndex]!;
    const now = new Date();
    return {
      from: subDays(now, preset.days).toISOString(),
      to: now.toISOString(),
    };
  }, [presetIndex]);

  const connections = connectionFilter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const clientIds = clientFilter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Main query (grouped per user choice).
  const main = useAnalyticsQuery(resource, {
    from,
    to,
    interval,
    groupBy,
    connection: connections,
    clientId: clientIds,
    limit: 1000,
  });

  // Summary query: same filters, no grouping — for the total tile.
  const summary = useAnalyticsQuery(resource, {
    from,
    to,
    interval,
    connection: connections,
    clientId: clientIds,
    limit: 1,
  });

  const handlePresetChange = (
    _e: React.MouseEvent<HTMLElement>,
    next: number | null,
  ) => {
    if (next === null) return;
    setPresetIndex(next);
    setInterval(PRESETS[next]!.interval);
  };

  const handleGroupByToggle = (
    _e: React.MouseEvent<HTMLElement>,
    next: AnalyticsGroupBy[],
  ) => {
    if (next.length === 0) return;
    setGroupBy(next);
  };

  const isTimeSeries = groupBy.includes("time");

  const { rows: chartRows, seriesKeys } = useMemo(() => {
    if (!main.data) return { rows: [], seriesKeys: [] as string[] };
    if (isTimeSeries) {
      return pivotForTimeSeries(
        main.data.data,
        resourceMeta.metric,
        groupBy,
      );
    }
    // Categorical: chart raw rows
    return {
      rows: main.data.data,
      seriesKeys: [resourceMeta.metric],
    };
  }, [main.data, isTimeSeries, resourceMeta.metric, groupBy]);

  const summaryValue =
    summary.data?.data[0]?.[resourceMeta.metric] ?? 0;

  return (
    <Box sx={{ p: 3 }}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ mb: 2 }}
      >
        <Typography variant="h4">Analytics</Typography>
        <Button
          variant="outlined"
          size="small"
          disabled={!main.data || main.data.data.length === 0}
          onClick={() =>
            main.data &&
            downloadCsv(
              `${resource}-${new Date().toISOString().slice(0, 10)}.csv`,
              main.data.data,
            )
          }
        >
          Export CSV
        </Button>
      </Stack>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={2} flexWrap="wrap" alignItems="center">
            <TextField
              select
              size="small"
              label="Resource"
              value={resource}
              onChange={(e) => {
                const next = e.target.value as AnalyticsResource;
                setResource(next);
                const allowed = RESOURCES.find((r) => r.value === next)!.dims;
                const filtered = groupBy.filter((d) => allowed.includes(d));
                setGroupBy(filtered.length > 0 ? filtered : ["time"]);
              }}
              sx={{ minWidth: 200 }}
            >
              {RESOURCES.map((r) => (
                <MenuItem key={r.value} value={r.value}>
                  {r.label}
                </MenuItem>
              ))}
            </TextField>

            <ToggleButtonGroup
              size="small"
              value={presetIndex}
              exclusive
              onChange={handlePresetChange}
            >
              {PRESETS.map((p, i) => (
                <ToggleButton key={p.label} value={i}>
                  {p.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            <TextField
              select
              size="small"
              label="Interval"
              value={interval}
              onChange={(e) => setInterval(e.target.value as AnalyticsInterval)}
              sx={{ minWidth: 110 }}
            >
              <MenuItem value="hour">Hour</MenuItem>
              <MenuItem value="day">Day</MenuItem>
              <MenuItem value="month">Month</MenuItem>
            </TextField>
          </Stack>

          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <Typography variant="body2" sx={{ minWidth: 80 }}>
              Group by:
            </Typography>
            <ToggleButtonGroup
              size="small"
              value={groupBy}
              onChange={handleGroupByToggle}
            >
              {resourceMeta.dims.map((d) => (
                <ToggleButton key={d} value={d}>
                  {d}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Stack>

          <Stack direction="row" spacing={2} flexWrap="wrap">
            <TextField
              size="small"
              label="Connections (comma-separated)"
              value={connectionFilter}
              onChange={(e) => setConnectionFilter(e.target.value)}
              placeholder="google-oauth2, Username-Password"
              sx={{ minWidth: 300 }}
            />
            <TextField
              size="small"
              label="Client IDs (comma-separated)"
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
              sx={{ minWidth: 300 }}
            />
          </Stack>
        </Stack>
      </Paper>

      {main.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {main.error.message}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2, height: "100%" }}>
            <Typography color="textSecondary" variant="body2">
              Total {resourceMeta.label}
            </Typography>
            {summary.loading ? (
              <CircularProgress size={24} sx={{ mt: 1 }} />
            ) : (
              <Typography variant="h3" sx={{ mt: 1 }}>
                {Number(summaryValue).toLocaleString()}
              </Typography>
            )}
            <Typography variant="caption" color="textSecondary">
              {format(parseISO(from), "MMM d, yyyy")} —{" "}
              {format(parseISO(to), "MMM d, yyyy")}
            </Typography>
            {(connections.length > 0 || clientIds.length > 0) && (
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: "wrap" }}>
                {connections.map((c) => (
                  <Chip key={`c-${c}`} size="small" label={`conn: ${c}`} />
                ))}
                {clientIds.map((c) => (
                  <Chip key={`a-${c}`} size="small" label={`app: ${c}`} />
                ))}
              </Stack>
            )}
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 8 }}>
          <Paper sx={{ p: 2, height: 400 }}>
            <Typography variant="subtitle1" sx={{ mb: 1 }}>
              {resourceMeta.label}{" "}
              {groupBy.length > 0 ? `by ${groupBy.join(", ")}` : ""}
            </Typography>
            {main.loading ? (
              <Box
                sx={{
                  height: 330,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CircularProgress />
              </Box>
            ) : chartRows.length === 0 ? (
              <Box
                sx={{
                  height: 330,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Typography color="textSecondary">No data</Typography>
              </Box>
            ) : isTimeSeries ? (
              <ResponsiveContainer width="100%" height={330}>
                <LineChart data={chartRows}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="time" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  {seriesKeys.map((key, i) => (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stroke={CHART_COLORS[i % CHART_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={330}>
                <BarChart data={chartRows} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey={groupBy[0] ?? "name"}
                    tick={{ fontSize: 11 }}
                    width={140}
                  />
                  <Tooltip />
                  <Bar dataKey={resourceMeta.metric} fill={CHART_COLORS[0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
}
