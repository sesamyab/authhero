import { useCallback, useEffect, useState } from "react";
import { useCreatePath, useDataProvider, useNotify } from "ra-core";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  ClientRegistrationTokenRecord,
} from "@/auth0DataProvider";
import {
  PRESET_LABELS,
  TokenStatusBadge,
  formatDate,
  presetOf,
} from "./shared";

/**
 * Developer invites of the tenant (#1776), newest first, with revoke. A used
 * invite links to the app it created.
 */
export function AppInvitesCard({ refreshKey }: { refreshKey: number }) {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();
  const createPath = useCreatePath();
  const [invites, setInvites] = useState<ClientRegistrationTokenRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInvites(
        await dataProvider.listClientRegistrationTokens({ source: "invite" }),
      );
    } catch {
      // Servers without the endpoint: show nothing rather than an error.
      setInvites([]);
    } finally {
      setLoading(false);
    }
  }, [dataProvider]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const revoke = async (id: string) => {
    try {
      await dataProvider.revokeClientRegistrationToken(id);
      notify("Invite revoked", { type: "success" });
      await load();
    } catch {
      notify("Could not revoke the invite", { type: "error" });
    }
  };

  if (!loading && invites.length === 0) return null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>App invites</CardTitle>
        <CardDescription>
          Links that let an outside developer register an app. An invite can be
          used once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>For</TableHead>
                <TableHead>App type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((invite) => {
                const preset = presetOf(invite.constraints);
                return (
                  <TableRow key={invite.id}>
                    <TableCell>{invite.name ?? "—"}</TableCell>
                    <TableCell>
                      {preset ? PRESET_LABELS[preset] : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <TokenStatusBadge status={invite.status} />
                        {invite.status === "used" && invite.client_id && (
                          <Link
                            className="text-sm underline"
                            to={createPath({
                              resource: "clients",
                              id: invite.client_id,
                              type: "edit",
                            })}
                          >
                            View app
                          </Link>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(invite.created_at)}</TableCell>
                    <TableCell>{formatDate(invite.expires_at)}</TableCell>
                    <TableCell className="text-right">
                      {invite.status === "active" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => revoke(invite.id)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
