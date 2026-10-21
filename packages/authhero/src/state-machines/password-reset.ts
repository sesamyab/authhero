import { assign, setup, transition } from "xstate";

export interface PasswordResetFlow {
  state: "awaiting_code" | "awaiting_link" | "completed";
  username: string;
  requestId: string;
}

export type PasswordResetEvent =
  | { type: "REQUEST_CODE"; username: string; requestId: string }
  | { type: "REQUEST_LINK"; username: string; requestId: string }
  | { type: "COMPLETE" };

/** A reset request belongs to the login session, independently of login progress. */
export const passwordResetMachine = setup({
  types: {
    context: {} as { username?: string; requestId?: string },
    events: {} as PasswordResetEvent,
  },
  actions: {
    setUsername: assign(({ event }) =>
      event.type === "COMPLETE"
        ? {}
        : { username: event.username, requestId: event.requestId },
    ),
  },
}).createMachine({
  id: "passwordReset",
  initial: "idle",
  context: {},
  // A resend or fresh request can restart the flow, including after completion.
  on: {
    REQUEST_CODE: { target: ".awaiting_code", actions: "setUsername" },
    REQUEST_LINK: { target: ".awaiting_link", actions: "setUsername" },
  },
  states: {
    idle: {},
    awaiting_code: { on: { COMPLETE: "completed" } },
    awaiting_link: { on: { COMPLETE: "completed" } },
    completed: {},
  },
});

/** Rehydrate the persisted child flow and reduce one domain event. */
export function transitionPasswordReset(
  flow: PasswordResetFlow | undefined,
  event: PasswordResetEvent,
): PasswordResetFlow | undefined {
  const snapshot = passwordResetMachine.resolveState({
    value: flow?.state ?? "idle",
    context: { username: flow?.username, requestId: flow?.requestId },
  });
  const [next] = transition(passwordResetMachine, snapshot, event);
  if (
    next.value === "idle" ||
    !next.context.username ||
    !next.context.requestId
  )
    return undefined;
  return {
    state: next.value as PasswordResetFlow["state"],
    username: next.context.username,
    requestId: next.context.requestId,
  };
}

/** Code and link submission endpoints accept only their own requested flow. */
export function canCompletePasswordReset(
  flow: PasswordResetFlow | undefined,
  method?: "code" | "link",
): flow is PasswordResetFlow {
  return (
    !!flow &&
    (method
      ? flow.state === `awaiting_${method}`
      : flow.state === "awaiting_code" || flow.state === "awaiting_link")
  );
}
