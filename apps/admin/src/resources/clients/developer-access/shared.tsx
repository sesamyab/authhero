import { useState } from "react";
import { useNotify } from "ra-core";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type {
  AppPreset,
  ClientRegistrationTokenRecord,
} from "@/auth0DataProvider";

export const PRESET_LABELS: Record<AppPreset, string> = {
  native: "Native app",
  spa: "Single-page app",
  regular_web: "Regular web app",
};

export const APP_PRESETS: AppPreset[] = ["native", "spa", "regular_web"];

export function isAppPreset(value: unknown): value is AppPreset {
  return APP_PRESETS.some((preset) => preset === value);
}

export function presetOf(
  constraints: Record<string, unknown> | undefined,
): AppPreset | undefined {
  const value = constraints?.app_type;
  return isAppPreset(value) ? value : undefined;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const STATUS_VARIANT: Record<
  ClientRegistrationTokenRecord["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  active: "default",
  used: "secondary",
  expired: "outline",
  revoked: "destructive",
};

export function TokenStatusBadge({
  status,
}: {
  status: ClientRegistrationTokenRecord["status"];
}) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="capitalize">
      {status}
    </Badge>
  );
}

/** A link shown once, with a copy button. */
export function OneTimeLink({
  url,
  expiresAt,
  warning,
}: {
  url: string;
  expiresAt: string;
  warning: string;
}) {
  const notify = useNotify();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        notify("Link copied to clipboard", { type: "success" });
      })
      .catch(() => notify("Failed to copy to clipboard", { type: "warning" }));
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input readOnly value={url} onFocus={(e) => e.target.select()} />
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          Copy
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Expires {formatDate(expiresAt)}. {warning}
      </p>
    </div>
  );
}
