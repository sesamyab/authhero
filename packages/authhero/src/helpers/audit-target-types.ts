/** Target entity types whose id identifies an affected user. For these, the
 *  flat log's `user_id` is the target (the user the operation acted on) rather
 *  than the actor — matching Auth0, e.g. "Delete a User" logs the deleted user.
 *  Shared by `helpers/logging.ts` (write path) and
 *  `outbox-destinations/logs.ts` (outbox transform) so the two never drift. */
export const USER_TARGET_TYPES = new Set(["user", "identity"]);

/** The flat log's `user_id` for an audit event: the target for user-scoped
 *  operations, otherwise the actor. The caller of a management operation is
 *  carried separately in `request.auth`. */
export function logSubjectUserId(event: {
  actor: { id?: string };
  target?: { type: string; id: string };
}): string {
  if (event.target && USER_TARGET_TYPES.has(event.target.type)) {
    return event.target.id || event.actor.id || "";
  }
  return event.actor.id || "";
}
