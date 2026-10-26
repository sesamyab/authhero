import { useEffect, useState } from "react";
import { useDataProvider } from "ra-core";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, parseISO, subDays } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { LogIcon } from "@/resources/logs/LogIcon";
import { getLogTypeDescription } from "@/lib/logs";
import { DateAgo } from "@/common/DateAgo";

interface DailyStats {
  date: string;
  logins: number;
  signups: number;
  leaked_passwords: number;
}

interface RecentLog {
  id: string;
  type: string;
  date: string;
  description?: string;
  user_name?: string;
  client_name?: string;
}

interface ChartDatum {
  date: string;
  value: number;
}

interface StatsCardProps {
  title: string;
  value: number | string;
  loading?: boolean;
}

function StatsCard({ title, value, loading }: StatsCardProps) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-11 w-28" />
        ) : (
          <div className="text-[44px] font-bold leading-none tracking-[-0.04em] tabular-nums">
            {typeof value === "number" ? value.toLocaleString() : value}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ChartCardProps {
  title: string;
  data: ChartDatum[];
  loading?: boolean;
  color?: string;
}

function ChartCard({
  title,
  data,
  loading,
  color = "var(--chart-1)",
}: ChartCardProps) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className="text-2xl font-bold tracking-[-0.03em] tabular-nums">
            {total.toLocaleString()}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {!loading && data.length > 0 && (
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={data} barCategoryGap="15%">
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => {
                  try {
                    return format(parseISO(v), "MMM d");
                  } catch {
                    return v;
                  }
                }}
                interval="preserveStartEnd"
                tickLine={false}
                axisLine={{ stroke: "var(--border)" }}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                width={32}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                cursor={{ fill: "var(--muted)" }}
                labelFormatter={(v) => {
                  try {
                    return format(parseISO(v as string), "MMM d, yyyy");
                  } catch {
                    return String(v);
                  }
                }}
              />
              <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function RecentActivity({
  logs,
  loading,
}: {
  logs: RecentLog[];
  loading?: boolean;
}) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center justify-between gap-3 border-b px-6 py-4">
        <h3 className="text-lg font-bold">Recent activity</h3>
        <Link
          to="/logs"
          className="text-sm font-semibold underline-offset-2 hover:underline"
        >
          All logs
        </Link>
      </div>
      {loading ? (
        <div className="flex flex-col gap-3 p-6">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : logs.length === 0 ? (
        <p className="px-6 py-8 text-sm text-muted-foreground">
          No activity yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-6 py-3 font-semibold">Event</th>
                <th className="px-6 py-3 font-semibold">User</th>
                <th className="px-6 py-3 font-semibold">Application</th>
                <th className="px-6 py-3 text-right font-semibold">When</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-t hover:bg-muted/50">
                  <td className="px-6 py-3">
                    <Link
                      to={`/logs/${encodeURIComponent(log.id)}/show`}
                      className="flex items-center gap-2"
                    >
                      <LogIcon type={log.type} />
                      {getLogTypeDescription(log.type)}
                    </Link>
                  </td>
                  <td className="px-6 py-3">{log.user_name || "—"}</td>
                  <td className="px-6 py-3 text-muted-foreground">
                    {log.client_name || "—"}
                  </td>
                  <td className="px-6 py-3 text-right text-muted-foreground">
                    <DateAgo date={log.date} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Dashboard() {
  const dataProvider = useDataProvider();
  const [stats, setStats] = useState<DailyStats[]>([]);
  const [counts, setCounts] = useState<{
    users?: number;
    clients?: number;
    connections?: number;
  }>({});
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<RecentLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    dataProvider
      .getList("logs", {
        pagination: { page: 1, perPage: 5 },
        sort: { field: "date", order: "DESC" },
        filter: {},
      })
      .then((res) => {
        if (!cancelled) setLogs(res.data as RecentLog[]);
      })
      .catch((err) => console.error("Recent activity load failed", err))
      .finally(() => {
        if (!cancelled) setLogsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const to = new Date();
        const from = subDays(to, 30);
        const statsRes = await dataProvider.getList("stats/daily", {
          pagination: { page: 1, perPage: 100 },
          sort: { field: "date", order: "ASC" },
          filter: {
            date_from: from.toISOString().slice(0, 10),
            date_to: to.toISOString().slice(0, 10),
          },
        });
        if (cancelled) return;
        setStats((statsRes.data as DailyStats[]) || []);

        const [usersRes, clientsRes, connectionsRes] = await Promise.allSettled(
          [
            dataProvider.getList("users", {
              pagination: { page: 1, perPage: 1 },
              sort: { field: "user_id", order: "DESC" },
              filter: {},
            }),
            dataProvider.getList("clients", {
              pagination: { page: 1, perPage: 1 },
              sort: { field: "id", order: "ASC" },
              filter: {},
            }),
            dataProvider.getList("connections", {
              pagination: { page: 1, perPage: 1 },
              sort: { field: "id", order: "ASC" },
              filter: {},
            }),
          ],
        );
        if (cancelled) return;
        setCounts({
          users:
            usersRes.status === "fulfilled" ? usersRes.value.total : undefined,
          clients:
            clientsRes.status === "fulfilled"
              ? clientsRes.value.total
              : undefined,
          connections:
            connectionsRes.status === "fulfilled"
              ? connectionsRes.value.total
              : undefined,
        });
      } catch (err) {
        console.error("Dashboard load failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dataProvider]);

  const loginsData = stats.map((s) => ({ date: s.date, value: s.logins ?? 0 }));
  const signupsData = stats.map((s) => ({
    date: s.date,
    value: s.signups ?? 0,
  }));

  return (
    <div className="flex flex-col gap-6 py-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-3xl font-bold tracking-[-0.04em] sm:text-4xl">
            Dashboard
          </h2>
          <p className="text-muted-foreground">Last 30 days</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link to="/logs">View logs</Link>
          </Button>
          <Button asChild>
            <Link to="/clients/create">Create application</Link>
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatsCard title="Users" value={counts.users ?? 0} loading={loading} />
        <StatsCard
          title="Applications"
          value={counts.clients ?? 0}
          loading={loading}
        />
        <StatsCard
          title="Connections"
          value={counts.connections ?? 0}
          loading={loading}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Daily logins" data={loginsData} loading={loading} />
        <ChartCard
          title="Daily signups"
          data={signupsData}
          loading={loading}
          color="var(--chart-2)"
        />
      </div>
      <RecentActivity logs={logs} loading={logsLoading} />
    </div>
  );
}
