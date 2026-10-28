import { useState } from "react";
import { useDataProvider, useNotify } from "ra-core";
import { Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AuthHeroDataProvider,
  ConfigSyncDifference,
  ConfigSyncVerification,
} from "@/auth0DataProvider";

const KIND_LABEL: Record<ConfigSyncDifference["kind"], string> = {
  missing: "missing",
  extra: "extra",
  changed: "changed",
  stale: "stale",
};

const KIND_TITLE: Record<ConfigSyncDifference["kind"], string> = {
  missing: "The tenant lacks a row it should have",
  extra: "The tenant has a row it should not",
  changed: "The row differs from what the parents publish",
  stale: "A copy the parents no longer publish",
};

/**
 * Checks, read-only and on request, that a tenant's config matches what its
 * parents publish. A synced tenant is checked against what a sync would write,
 * which sees a copy someone deleted or edited although the stored hash still
 * matches. A pass is no difference and no error.
 */
export function VerifyConfig({ tenantId }: { tenantId: string }) {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConfigSyncVerification | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const verify = async () => {
    setRunning(true);
    try {
      setResult(await dataProvider.verifyConfigSync(tenantId));
      setCheckedAt(new Date());
    } catch (error) {
      notify(
        error && typeof error === "object" && "message" in error
          ? String(error.message)
          : "Could not verify the config",
        { type: "error" },
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="mt-4 flex flex-col gap-2 text-sm"
      data-testid="verify-config"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={verify}
          disabled={running}
          title="Compare this tenant's config with what its parents publish. Nothing is written."
        >
          {running ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4 mr-1" />
          )}
          Verify
        </Button>
        {result && (
          <>
            {result.ok ? (
              <Badge variant="outline">Matches</Badge>
            ) : (
              <Badge variant="destructive">
                {result.differences.length + result.errors.length} problem(s)
              </Badge>
            )}
            {checkedAt && (
              <span className="text-xs text-muted-foreground">
                {checkedAt.toLocaleTimeString()}
              </span>
            )}
          </>
        )}
      </div>

      {result && result.differences.length > 0 && (
        <ul className="flex flex-col gap-1">
          {result.differences.map((d) => (
            <li key={`${d.kind}:${d.entity}:${d.key}`} className="flex gap-2">
              <Badge variant="destructive" title={KIND_TITLE[d.kind]}>
                {KIND_LABEL[d.kind]}
              </Badge>
              <span>{d.entity}</span>
              <span className="font-mono text-xs">{d.key}</span>
              {d.fields && d.fields.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  ({d.fields.join(", ")})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {result && result.errors.length > 0 && (
        <ul className="font-mono text-xs text-destructive">
          {result.errors.map((message, i) => (
            <li key={i}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
