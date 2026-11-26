import { useCreatePath, useGetList } from "ra-core";
import { Link } from "react-router-dom";
import { describeMessageTypes } from "./notification-message-types";

interface NotificationBinding {
  id: string;
  hook_id?: string;
  trigger_id: string;
  enabled: boolean;
  code_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Shows which enabled actions deliver messages for a custom provider trigger
 * and links to the trigger on the Triggers page. Used on the email provider
 * and MFA SMS settings, so the provider pages say when an action takes over.
 */
export function CustomProviderNotice({
  triggerId,
  requireAction = false,
}: {
  triggerId: "custom-email-provider" | "custom-phone-provider";
  /** The provider is "custom": every message must go to an action. */
  requireAction?: boolean;
}) {
  const createPath = useCreatePath();
  const { data, isPending } = useGetList<NotificationBinding>("hooks", {
    pagination: { page: 1, perPage: 100 },
    sort: { field: "priority", order: "DESC" },
  });
  const bindings = (data ?? []).filter(
    (hook) =>
      hook.trigger_id === triggerId &&
      hook.enabled &&
      typeof hook.code_id === "string",
  );
  const triggerPath = `${createPath({ resource: "action-triggers", type: "list" })}#${triggerId}`;
  const channel =
    triggerId === "custom-email-provider" ? "emails" : "text messages";

  return (
    <div className="rounded-md border p-3 text-sm flex flex-col gap-1">
      <span className="font-medium">
        {triggerId === "custom-email-provider"
          ? "Custom email provider action"
          : "Custom phone provider action"}
      </span>
      {isPending ? (
        <span className="text-muted-foreground">Loading…</span>
      ) : bindings.length === 0 ? (
        <span
          className={
            requireAction ? "text-destructive" : "text-muted-foreground"
          }
        >
          {requireAction
            ? `No action is bound, so ${channel} can't be sent. Bind an action to the trigger.`
            : `No action is bound. Bind one to deliver some or all ${channel} from your own system.`}
        </span>
      ) : (
        <span className="text-muted-foreground">
          {bindings
            .map((b) => describeMessageTypes(triggerId, b.metadata))
            .join("; ")}{" "}
          {requireAction
            ? "go to the bound action."
            : "go to the bound action; everything else uses the provider below."}
        </span>
      )}
      <Link to={triggerPath} className="text-primary underline w-fit">
        Manage the {triggerId} trigger
      </Link>
    </div>
  );
}
