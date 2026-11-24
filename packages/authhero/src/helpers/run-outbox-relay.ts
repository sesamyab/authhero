import { CodeExecutor, DataAdapters } from "@authhero/adapter-interfaces";
import type {
  ActionExecutionLogCapture,
  OutboxFirehoseConfig,
  OutboxPipelineConfig,
  WebhookInvoker,
} from "../types/AuthHeroConfig";
import type { OutboxMetricsSink } from "../types/OutboxMetrics";
import { drainOutbox } from "./outbox-relay";
import { cleanupOutbox } from "./outbox-cleanup";
import { createDefaultDestinations } from "./default-destinations";
import { makeOutboxServiceTokenFactory } from "./service-token";

export interface RunOutboxRelayConfig {
  /** Same `DataAdapters` passed to `init()`. Must include `outbox` to drain. */
  dataAdapter: DataAdapters;

  /**
   * Issuer URL used when minting per-tenant `auth-service` tokens (typically
   * your `env.ISSUER`). Webhook handlers that validate `iss` against this
   * URL will accept tokens from both the inline dispatcher and this cron
   * relay.
   */
  issuer: string;

  /**
   * Optional webhook invoker — same shape as the one accepted by `init()`.
   * When provided, cron-drained `hook.*` events go through this invoker,
   * matching the inline per-request dispatch path exactly.
   */
  webhookInvoker?: WebhookInvoker;

  /** Days to retain processed events before cleanup. Default 7. */
  retentionDays?: number;

  /** Forwarded to `drainOutbox`. */
  batchSize?: number;

  /** Forwarded to `drainOutbox`. */
  maxRetries?: number;

  /** Webhook HTTP timeout (ms), when the default invoker is used. */
  webhookTimeoutMs?: number;

  /**
   * Optional code executor — same instance passed to `init({ codeExecutor })`.
   * When provided, cron-drained `hook.*` events also run tenant code hooks, so
   * a code hook that failed per-request delivery is retried rather than
   * silently skipped.
   */
  codeExecutor?: CodeExecutor;

  /**
   * Same value as `init({ actionExecutionLogs })`, so code hooks run by this
   * cron drain persist console output the same way as inline deliveries.
   * Defaults to `"full"`.
   */
  actionExecutionLogs?: ActionExecutionLogCapture;

  /**
   * Optional metrics sink — same shape as `init({ outbox: { metrics } })`.
   * Receives `outbox_events_processed_total`,
   * `outbox_events_dead_lettered_total` and `outbox_retry_delay_seconds` for
   * the events this cron drain handles, tagged `source: "cron"`.
   */
  metrics?: OutboxMetricsSink;

  /**
   * Same value as `init({ outbox: { pipeline } })`. Pass it so events retried
   * by this drain still reach the archive — otherwise an event whose inline
   * archive delivery failed is marked processed here without being archived.
   */
  pipeline?: OutboxPipelineConfig;

  /** Same value as `init({ outbox: { firehose } })`. See `pipeline`. */
  firehose?: OutboxFirehoseConfig;
}

/**
 * One-call outbox relay for cron / scheduled handlers.
 *
 * Internally:
 * 1. Skips gracefully when `dataAdapter.outbox` is undefined.
 * 2. Builds the same destination array as the inline dispatcher
 *    (`LogsDestination`, `WebhookDestination`, `RegistrationFinalizerDestination`,
 *    plus the archive destinations when `pipeline` / `firehose` are passed).
 * 3. Mints per-tenant service tokens via the same in-process path
 *    (`createServiceTokenCore`) that the request-time webhookInvoker uses,
 *    driven by the supplied dataAdapter.
 * 4. Runs `drainOutbox`, then `cleanupOutbox`.
 *
 * This is intended to be the entire body of a consumer's scheduled handler
 * for outbox maintenance — consumers should not need to call `drainOutbox` /
 * `cleanupOutbox` / `createDefaultDestinations` directly.
 *
 * @example
 * ```ts
 * export default {
 *   async scheduled(_event, env) {
 *     await runOutboxRelay({
 *       dataAdapter,
 *       issuer: env.ISSUER,
 *       webhookInvoker,   // same function passed to init()
 *       retentionDays: 7,
 *     });
 *   },
 * };
 * ```
 */
export async function runOutboxRelay(
  config: RunOutboxRelayConfig,
): Promise<void> {
  const {
    dataAdapter,
    issuer,
    webhookInvoker,
    retentionDays = 7,
    batchSize,
    maxRetries,
    webhookTimeoutMs,
    codeExecutor,
    actionExecutionLogs,
    metrics,
    pipeline,
    firehose,
  } = config;

  if (!dataAdapter.outbox) {
    return;
  }

  const getServiceToken = makeOutboxServiceTokenFactory({
    tenants: dataAdapter.tenants,
    keys: dataAdapter.keys,
    issuer,
  });

  const destinations = createDefaultDestinations({
    dataAdapter,
    getServiceToken,
    webhookTimeoutMs,
    webhookInvoker,
    codeExecutor,
    actionExecutionLogs,
    pipeline,
    firehose,
  });

  let drainError: unknown;
  try {
    await drainOutbox(dataAdapter.outbox, destinations, {
      batchSize,
      maxRetries,
      retentionDays,
      metrics,
    });
  } catch (error) {
    drainError = error;
  }

  await cleanupOutbox(dataAdapter.outbox, { retentionDays });

  if (drainError !== undefined) {
    throw drainError;
  }
}
