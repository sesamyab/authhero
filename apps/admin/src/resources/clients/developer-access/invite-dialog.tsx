import { useState } from "react";
import { useDataProvider, useGetList, useNotify } from "ra-core";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import type { AppPreset, AuthHeroDataProvider } from "@/auth0DataProvider";
import { APP_PRESETS, OneTimeLink, PRESET_LABELS, isAppPreset } from "./shared";

const PRESET_DESCRIPTIONS: Record<AppPreset, string> = {
  native:
    "iOS, Android or desktop app. Public client with PKCE, no client secret.",
  spa: "Browser app without a backend. Public client with PKCE, no client secret.",
  regular_web:
    "Server-side web app. Gets a client secret, shown once to the developer.",
};

const EXPIRY_DAYS = [1, 3, 7, 14, 30];

interface ConnectionRecord {
  id: string;
  name?: string;
  strategy?: string;
}

interface Minted {
  id: string;
  ticket: string;
  expires_at: string;
}

/**
 * "Invite a developer to register an app" (#1776): mints an invite from an
 * app-type preset and shows the setup link once.
 */
export function InviteDeveloperButton({
  onInvited,
}: {
  onInvited?: () => void;
}) {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<AppPreset>("native");
  const [name, setName] = useState("");
  const [days, setDays] = useState("7");
  const [pinConnections, setPinConnections] = useState(false);
  const [connections, setConnections] = useState<string[]>([]);
  const [thirdParty, setThirdParty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [minted, setMinted] = useState<Minted | null>(null);

  const { data: availableConnections, isPending } =
    useGetList<ConnectionRecord>(
      "connections",
      { pagination: { page: 1, perPage: 200 } },
      { enabled: open && pinConnections },
    );

  const reset = () => {
    setPreset("native");
    setName("");
    setDays("7");
    setPinConnections(false);
    setConnections([]);
    setThirdParty(false);
    setMinted(null);
  };

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      if (minted) onInvited?.();
      reset();
    }
  };

  const toggleConnection = (id: string, checked: boolean) => {
    setConnections((current) =>
      checked ? [...current, id] : current.filter((c) => c !== id),
    );
  };

  const create = async () => {
    setSaving(true);
    try {
      const result = await dataProvider.createDeveloperInvite({
        preset,
        name: name.trim(),
        expires_in_seconds: Number(days) * 24 * 60 * 60,
        ...(pinConnections ? { connections } : {}),
        is_first_party: !thirdParty,
      });
      setMinted(result);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Could not create the invite",
        { type: "error" },
      );
    } finally {
      setSaving(false);
    }
  };

  const revoke = async () => {
    if (!minted) return;
    try {
      await dataProvider.revokeClientRegistrationToken(minted.id);
      notify("Invite revoked", { type: "success" });
      close(false);
    } catch {
      notify("Could not revoke the invite", { type: "error" });
    }
  };

  const canCreate =
    name.trim().length > 0 && (!pinConnections || connections.length > 0);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <UserPlus className="h-4 w-4" />
        Invite a developer
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Invite a developer to register an app</DialogTitle>
            <DialogDescription>
              The developer opens the link, enters the app&apos;s name and URLs
              on a page with your branding, and gets the client ID. They
              don&apos;t get an account.
            </DialogDescription>
          </DialogHeader>

          {minted ? (
            <div className="space-y-4">
              <OneTimeLink
                url={minted.ticket}
                expiresAt={minted.expires_at}
                warning="Anyone with this link can register one app. Send it only to the developer. It is not shown again."
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={revoke}>
                  Revoke
                </Button>
                <Button type="button" onClick={() => close(false)}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label>App type</Label>
                <RadioGroup
                  value={preset}
                  onValueChange={(value) => {
                    if (isAppPreset(value)) setPreset(value);
                  }}
                >
                  {APP_PRESETS.map((key) => (
                    <label
                      key={key}
                      htmlFor={`preset-${key}`}
                      className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
                    >
                      <RadioGroupItem
                        value={key}
                        id={`preset-${key}`}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium">
                          {PRESET_LABELS[key]}
                        </span>
                        <span className="block text-sm text-muted-foreground">
                          {PRESET_DESCRIPTIONS[key]}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-name">Who is this for?</Label>
                <Input
                  id="invite-name"
                  value={name}
                  maxLength={255}
                  placeholder="For example: Agency, iOS app"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label>Link expires in</Label>
                <Select value={days} onValueChange={setDays}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_DAYS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d === 1 ? "1 day" : `${d} days`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="pin-connections">
                      Choose specific login methods
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Off: the app can use all of the tenant&apos;s login
                      methods, including ones added later.
                    </p>
                  </div>
                  <Switch
                    id="pin-connections"
                    checked={pinConnections}
                    onCheckedChange={setPinConnections}
                  />
                </div>
                {pinConnections && (
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      (availableConnections ?? []).map((c) => (
                        <label
                          key={c.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={connections.includes(c.id)}
                            onCheckedChange={(checked) =>
                              toggleConnection(c.id, checked === true)
                            }
                          />
                          {c.name ?? c.id}
                          {c.strategy && (
                            <span className="text-muted-foreground">
                              ({c.strategy})
                            </span>
                          )}
                        </label>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="third-party">
                    Show a consent screen to users
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Treat the app as third-party. Off: users sign in without a
                    consent screen, like your own apps.
                  </p>
                </div>
                <Switch
                  id="third-party"
                  checked={thirdParty}
                  onCheckedChange={setThirdParty}
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => close(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!canCreate || saving}
                  onClick={create}
                >
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Create link
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
