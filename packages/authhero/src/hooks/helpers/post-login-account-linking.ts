import { Context } from "hono";
import { DataAdapters, LogTypes, User } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { logMessage } from "../../helpers/logging";
import { compareUsersByAge } from "../../helpers/users";
import { ExternalConnectionLookup } from "./action-users";

/**
 * The `user` namespace exposed to `post-user-login` code hooks. `setLinkedTo`
 * is the programmable account-linking verb (issue #1184): an action reads
 * `event.link_candidates` and calls `api.user.setLinkedTo(candidate.user_id)`.
 */
export type PostLoginUserApi = {
  user: {
    setLinkedTo: (primaryUserId: string) => Promise<void>;
  };
};

/**
 * Builds the guarded `api.user.setLinkedTo` implementation for the
 * `post-user-login` trigger, plus a getter for the resulting primary user id.
 *
 * The recording proxy captures the action's `setLinkedTo(id)` call; the host
 * replays it against this implementation *after* the isolate returns
 * (`replayApiCalls`, which awaits — so the DB writes complete before the login
 * response is built).
 *
 * Guards, all enforced server-side so a malicious/buggy action cannot escalate:
 *  - **Candidate allowlist.** `primaryUserId` must be one of `candidates`
 *    (the same set serialized into `event.link_candidates`). Without this an
 *    action could link the current user to an arbitrary `user_id` —
 *    account-takeover. Rejections log `FAILED_HOOK` and mutate nothing.
 *  - **Verified-email gate.** When `requireVerifiedEmail` (the default), the
 *    logging-in user must have a verified email, regardless of what the action
 *    asserts.
 *    Users created by `api.users.ensure` in the same execution are also
 *    allowed (issue #1802); they skip the verified-email gate because the
 *    action resolved the person against its own system of record.
 *  - **Direction.** A primary in an `external` connection (an anchor) always
 *    stays primary. Otherwise the older account wins (`compareUsersByAge`):
 *    if the logging-in user pre-dates the target, the target is demoted
 *    instead. Either way the write goes through the update decorator's
 *    `linkUserTo` chokepoint, which keeps the cluster a single hop deep.
 *  - **No re-anchoring.** A user already under one anchor is never moved
 *    under a different one by a login; that is an admin operation.
 *  - **Idempotency.** A no-op when the user is already linked to the target.
 */
export function createPostLoginUserApi(params: {
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>;
  data: DataAdapters;
  tenantId: string;
  user: User;
  /** Resolved candidate primaries (same set as `event.link_candidates`). */
  candidates: User[];
  /** @default true */
  requireVerifiedEmail?: boolean;
  /**
   * user_ids created or updated by `api.users.ensure` earlier in the same
   * execution. Read at replay time, so it must be the live set.
   */
  ensuredUserIds?: ReadonlySet<string>;
  /** Tells anchors (users in an `external` connection) apart. */
  externalConnections?: ExternalConnectionLookup;
}): {
  api: PostLoginUserApi;
  /** The user id of the primary after linking, or null if nothing linked. */
  getLinkedPrimaryId: () => string | null;
} {
  const { ctx, data, tenantId, candidates, externalConnections } = params;
  const requireVerifiedEmail = params.requireVerifiedEmail ?? true;
  const ensuredUserIds = params.ensuredUserIds ?? new Set<string>();

  // `currentUser` tracks the logging-in user's `linked_to` across multiple
  // setLinkedTo calls within one execution so repeats resolve to a no-op.
  let currentUser = params.user;
  let linkedPrimaryId: string | null = null;

  const refuse = (reason: string, description: string, target: string) => {
    logMessage(ctx, tenantId, {
      type: LogTypes.FAILED_HOOK,
      description,
      userId: currentUser.user_id,
      details: {
        trigger_id: "post-user-login",
        reason,
        primary_user_id: target,
      },
    });
  };

  const isAnchor = async (user: User): Promise<boolean> =>
    !user.linked_to &&
    !!externalConnections &&
    (await externalConnections.isExternalUser(user));

  const setLinkedTo = async (primaryUserId: string): Promise<void> => {
    // Guard: only users pushed into event.link_candidates, or ensured by this
    // execution, are linkable.
    const isEnsured = ensuredUserIds.has(primaryUserId);
    const target = isEnsured
      ? await data.users.get(tenantId, primaryUserId)
      : candidates.find((c) => c.user_id === primaryUserId);
    if (!target) {
      refuse(
        "not_a_link_candidate",
        `post-user-login action tried to link ${currentUser.user_id} to non-candidate ${primaryUserId}`,
        primaryUserId,
      );
      return;
    }

    // Idempotent: the user already is, or is already linked to, the target.
    if (
      currentUser.user_id === target.user_id ||
      currentUser.linked_to === target.user_id
    ) {
      linkedPrimaryId = target.user_id;
      return;
    }

    // Verified-email gate enforced host-side, never trusting the action.
    // Ensured targets were resolved by the action against its own records.
    if (
      !isEnsured &&
      requireVerifiedEmail &&
      (!currentUser.email || !currentUser.email_verified)
    ) {
      refuse(
        "unverified_email",
        `post-user-login action link refused: ${currentUser.user_id} has no verified email`,
        primaryUserId,
      );
      return;
    }

    // The primary the logging-in user resolves to right now. Usually the user
    // itself (post-login runs on the primary), but an earlier setLinkedTo in
    // this execution may already have moved it.
    const currentPrimary = currentUser.linked_to
      ? ((await data.users.get(tenantId, currentUser.linked_to)) ?? currentUser)
      : currentUser;
    const [currentIsAnchor, targetIsAnchor] = await Promise.all([
      isAnchor(currentPrimary),
      isAnchor(target),
    ]);

    if (currentIsAnchor && targetIsAnchor) {
      refuse(
        "already_anchored",
        `post-user-login action link refused: ${currentUser.user_id} is already anchored to ${currentPrimary.user_id}`,
        primaryUserId,
      );
      return;
    }

    // Each branch is a plain single-field `linked_to` write: `data` is the
    // decorated adapter set, so the update decorator's chokepoint repoints any
    // accounts already linked to the demoted side and resolves the target to
    // its cluster root, keeping the graph a single hop deep (issue #1250).
    const demoteTarget = async (primaryId: string) => {
      await data.users.update(tenantId, target.user_id, {
        linked_to: primaryId,
      });
      linkedPrimaryId = primaryId;
    };
    // Demote the primary that was classified, not just the logging-in
    // identity: when an earlier call already put the user under another
    // primary, that whole cluster moves (the chokepoint repoints its
    // secondaries, including the logging-in user).
    const demoteCurrent = async () => {
      await data.users.update(tenantId, currentPrimary.user_id, {
        linked_to: target.user_id,
      });
      currentUser = { ...currentUser, linked_to: target.user_id };
      linkedPrimaryId = target.user_id;
    };

    if (targetIsAnchor) {
      // The anchor wins regardless of age.
      await demoteCurrent();
    } else if (currentIsAnchor) {
      // The logging-in user is already under an anchor: pull the target into
      // that cluster rather than moving the user out of it.
      await demoteTarget(currentPrimary.user_id);
    } else if (compareUsersByAge(currentPrimary, target) < 0) {
      // Older account wins. If the logging-in user's primary pre-dates the
      // target, demote the target rather than turning the older account into
      // a secondary.
      await demoteTarget(currentPrimary.user_id);
    } else {
      await demoteCurrent();
    }
  };

  return {
    api: { user: { setLinkedTo } },
    getLinkedPrimaryId: () => linkedPrimaryId,
  };
}
