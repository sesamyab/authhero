import { Gauge } from "lucide-react";
import type { TenantCreationLimit } from "@/auth0DataProvider";
import { cn } from "@/lib/utils";
import { creationLimitReached, describeCreationLimit } from "./deployment";

/** A thin bar showing how much of the cap is used. */
function Bar({
  used,
  limit,
  reached,
  className,
}: {
  used: number;
  limit: number;
  reached: boolean;
  className?: string;
}) {
  const share = limit === 0 ? 1 : Math.min(used / limit, 1);
  return (
    <div
      role="meter"
      aria-label="Tenants used"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(used, limit)}
      className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          reached ? "bg-destructive" : "bg-yellow-400",
        )}
        style={{ width: `${share * 100}%` }}
      />
    </div>
  );
}

/** The same meter as a ring, for toolbars where a bar is too wide. */
function Ring({
  used,
  limit,
  reached,
}: {
  used: number;
  limit: number;
  reached: boolean;
}) {
  const size = 22;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const share = limit === 0 ? 1 : Math.min(used / limit, 1);
  return (
    <svg
      role="meter"
      aria-label="Tenants used"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(used, limit)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-muted"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - share)}
        className={cn(
          "transition-[stroke-dashoffset]",
          reached ? "stroke-destructive" : "stroke-yellow-400",
        )}
      />
    </svg>
  );
}

/**
 * How many tenants the user has created against their cap. Renders nothing
 * when there is no cap (an operator, an unlimited user, an old server), so a
 * caller can drop it in anywhere. `compact` is a pill for toolbars; the
 * default is a box for forms that also says what to do when the cap is hit.
 */
export function CreationLimitMeter({
  limit,
  compact = false,
  className,
}: {
  limit: TenantCreationLimit | undefined;
  compact?: boolean;
  className?: string;
}) {
  const text = describeCreationLimit(limit);
  if (!limit || limit.limit === null || !text) return null;
  const reached = creationLimitReached(limit);

  if (compact) {
    return (
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-full border bg-background py-1 pl-1.5 pr-3 text-xs",
          reached
            ? "border-destructive/40 text-destructive"
            : "text-muted-foreground",
          className,
        )}
      >
        <Ring used={limit.used} limit={limit.limit} reached={reached} />
        <span className="whitespace-nowrap">{text}</span>
      </div>
    );
  }

  return (
    <div
      role={reached ? "alert" : "status"}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-background p-3",
        reached && "border-destructive/40",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <Gauge
          className={cn(
            "h-4 w-4 shrink-0",
            reached ? "text-destructive" : "text-muted-foreground",
          )}
          aria-hidden
        />
        <span className="font-medium">{text}</span>
      </div>
      <Bar used={limit.used} limit={limit.limit} reached={reached} />
      {reached && (
        <p className="text-xs text-destructive">
          You have reached the limit. Contact an administrator to raise it.
        </p>
      )}
    </div>
  );
}
