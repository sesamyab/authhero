import { useCallback, useEffect, useState } from "react";
import { useDataProvider, useNotify, useRecordContext } from "ra-core";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { OneTimeLink, TokenStatusBadge, formatDate } from "./shared";

const DAY = 24 * 60 * 60;

const SOURCE_LABELS: Record<string, string> = {
  invite: "Invite",
  edit_link: "Edit link",
  registration: "Registration access token",
  connect: "Connect consent",
};

interface ClientRecord {
  id?: string;
  registration_type?: string;
  registration_metadata?: Record<string, unknown>;
}

/**
 * Developer access to one app (#1776): how it was registered, edit links for
 * its outside developer, and the registration tokens that can still change it.
 */
export function DeveloperAccessTab() {
  const record = useRecordContext<ClientRecord>();
  const clientId = record?.id;
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();

  const [tokens, setTokens] = useState<ClientRegistrationTokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [longLived, setLongLived] = useState(false);
  const [saving, setSaving] = useState(false);
  const [link, setLink] = useState<{
    ticket: string;
    expires_at: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    try {
      setTokens(
        await dataProvider.listClientRegistrationTokens({
          client_id: clientId,
        }),
      );
    } catch {
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, [clientId, dataProvider]);

  useEffect(() => {
    load();
  }, [load]);

  if (!clientId) return null;

  const invite = tokens.find((t) => t.source === "invite");
  const active = tokens.filter(
    (t) => t.type === "rat" && t.status === "active",
  );

  const generate = async () => {
    setSaving(true);
    try {
      const result = await dataProvider.createClientRegistrationTicket(
        clientId,
        (longLived ? 30 : 7) * DAY,
      );
      setLink(result);
      await load();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not create the link",
        { type: "error" },
      );
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (ids: string[]) => {
    try {
      for (const id of ids) {
        await dataProvider.revokeClientRegistrationToken(id);
      }
      notify(ids.length > 1 ? "Developer access revoked" : "Link revoked", {
        type: "success",
      });
      await load();
    } catch {
      notify("Could not revoke", { type: "error" });
    }
  };

  const closeDialog = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setLink(null);
      setLongLived(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Developer access</CardTitle>
          <CardDescription>
            Give the app&apos;s developer a link to change its name, logo,
            callback, logout and web origin URLs. They can&apos;t change
            anything else, and they don&apos;t get an account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {invite && (
            <p className="text-sm">
              Registered through the invite{" "}
              <span className="font-medium">{invite.name ?? invite.id}</span> on{" "}
              {formatDate(invite.used_at ?? invite.created_at)}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setDialogOpen(true)}>
              Generate edit link
            </Button>
            {active.length > 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => revoke(active.map((t) => t.id))}
              >
                Revoke all developer access
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Links and tokens</CardTitle>
          <CardDescription>
            Edit links and registration access tokens that can read or update
            this app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell>
                      {(token.source && SOURCE_LABELS[token.source]) ??
                        (token.type === "rat"
                          ? "Registration access token"
                          : "Initial access token")}
                    </TableCell>
                    <TableCell>
                      <TokenStatusBadge status={token.status} />
                    </TableCell>
                    <TableCell>{formatDate(token.created_at)}</TableCell>
                    <TableCell>
                      {token.expires_at
                        ? formatDate(token.expires_at)
                        : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      {token.type === "rat" && token.status === "active" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => revoke([token.id])}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={closeDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate edit link</DialogTitle>
            <DialogDescription>
              The link opens a page with your branding, pre-filled with the
              app&apos;s current settings. A new link replaces the app&apos;s
              previous edit links.
            </DialogDescription>
          </DialogHeader>
          {link ? (
            <div className="space-y-4">
              <OneTimeLink
                url={link.ticket}
                expiresAt={link.expires_at}
                warning="Anyone with this link can change this app's URLs until it expires. It is not shown again."
              />
              <DialogFooter>
                <Button type="button" onClick={() => closeDialog(false)}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="long-lived">Keep active for 30 days</Label>
                  <p className="text-sm text-muted-foreground">
                    Off: the link expires after 7 days.
                  </p>
                </div>
                <Switch
                  id="long-lived"
                  checked={longLived}
                  onCheckedChange={setLongLived}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => closeDialog(false)}
                >
                  Cancel
                </Button>
                <Button type="button" disabled={saving} onClick={generate}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Generate link
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the app was registered by an outside developer through an invite. */
export function isInvitedClient(
  record: Record<string, unknown> | undefined,
): boolean {
  const metadata = record?.registration_metadata;
  return (
    record?.registration_type === "iat_dcr" &&
    isObject(metadata) &&
    typeof metadata.registration_token_id === "string"
  );
}
