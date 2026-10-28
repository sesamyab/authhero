import type { DeviceCode, DeviceCodePatch } from "../types/DeviceCode";

/** RFC 8628 grants. Both codes are SHA-256 hashes; never store the wire device code. */
export interface DeviceCodesAdapter {
  /** Must reject duplicate device/user code hashes within the tenant. */
  create(tenantId: string, code: DeviceCode): Promise<void>;
  get(tenantId: string, deviceCodeHash: string): Promise<DeviceCode | null>;
  getByUserCode(
    tenantId: string,
    userCodeHash: string,
  ): Promise<DeviceCode | null>;
  /** Atomic compare-and-swap. Increment version iff the expected version matches. */
  update(
    tenantId: string,
    deviceCodeHash: string,
    version: number,
    patch: DeviceCodePatch,
  ): Promise<boolean>;
  /** Atomically increment a fixed-window throttle bucket; return its new count. */
  incrementAttempts(
    tenantId: string,
    key: string,
    expiresAt: string,
  ): Promise<number>;
  /** Delete expired grants and throttle buckets globally. DynamoDB may use TTL. */
  cleanup(olderThan: string): Promise<number>;
}
