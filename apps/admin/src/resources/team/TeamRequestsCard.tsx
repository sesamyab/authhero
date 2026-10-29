import { Loader2 } from "lucide-react";
import type { TeamRequestRecord } from "../../auth0DataProvider";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Finished requests stay on the page this long, so a result is seen. */
const SUCCEEDED_VISIBLE_MS = 60 * 60 * 1000;

/**
 * The requests worth showing: every one that is waiting or failed (a failure
 * is something to act on), and the ones that succeeded in the last hour.
 */
export function visibleTeamRequests(
  requests: TeamRequestRecord[],
  now = Date.now(),
): TeamRequestRecord[] {
  return requests.filter((request) => {
    if (request.status !== "succeeded") return true;
    const finished = Date.parse(request.finished_at ?? request.updated_at);
    return Number.isNaN(finished) || now - finished < SUCCEEDED_VISIBLE_MS;
  });
}

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/** "1 member", "3 members", or the bare plural when the payload has no list. */
const noun = (n: number, word: string) =>
  n === 1 ? `1 ${word}` : n > 1 ? `${n} ${word}s` : `${word}s`;

/** One line saying what was asked, from the request's payload. */
export function describeTeamRequest(request: TeamRequestRecord): string {
  const payload = request.payload ?? {};
  const member = String(payload.user_id ?? "a member");
  switch (request.kind) {
    case "invite": {
      const email = (payload.invitee as { email?: string } | undefined)?.email;
      return email ? `Invite ${email}` : "Invite a member";
    }
    case "add_members":
      return `Add ${noun(count(payload.user_ids), "member")}`;
    case "remove_members":
      return `Remove ${noun(count(payload.user_ids), "member")}`;
    case "assign_roles":
      return `Give ${noun(count(payload.roles), "role")} to ${member}`;
    case "remove_roles":
      return `Take ${noun(count(payload.roles), "role")} from ${member}`;
    case "revoke_invitation":
      return "Revoke an invitation";
    default:
      return request.kind;
  }
}

function StatusBadge({ request }: { request: TeamRequestRecord }) {
  switch (request.status) {
    case "pending":
      return (
        <Badge
          variant="secondary"
          title="Registered here. The control plane carries it out."
        >
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          Waiting
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return <Badge variant="outline">Done</Badge>;
  }
}

/**
 * The team changes this tenant asked for and how they went (issue #1550). A
 * change made here is a request the control plane carries out, so the Team
 * list below can lag behind until it is done; a failure says why.
 */
export function TeamRequestsCard({
  requests,
}: {
  requests: TeamRequestRecord[];
}) {
  const shown = visibleTeamRequests(requests);
  if (shown.length === 0) return null;

  return (
    <Card data-testid="team-requests">
      <CardHeader>
        <CardTitle className="text-base">Requested changes</CardTitle>
        <CardDescription>
          Team changes are carried out by the control plane. They show up in the
          lists once they are done.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {shown.map((request) => (
            <li
              key={request.id}
              className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="text-sm">
                {describeTeamRequest(request)}
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(request.created_at).toLocaleString()}
                </span>
                {request.status === "failed" && request.error ? (
                  <div className="text-xs text-destructive">
                    {request.error}
                  </div>
                ) : null}
              </div>
              <StatusBadge request={request} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
