import type {
  ResolvedSessionTransfer,
  SessionTransferAuthenticationMethod,
  SessionTransferDeviceBinding,
} from "@authhero/adapter-interfaces";

// In the order the API documents them, so a saved list reads the same however
// the boxes were ticked.
export const AUTHENTICATION_METHODS: readonly SessionTransferAuthenticationMethod[] =
  ["cookie", "query"];

export const DEVICE_BINDINGS: readonly SessionTransferDeviceBinding[] = [
  "ip",
  "asn",
  "none",
];

export function isDeviceBinding(
  value: unknown,
): value is SessionTransferDeviceBinding {
  return DEVICE_BINDINGS.some((binding) => binding === value);
}

export function toggleAuthenticationMethod(
  current: readonly SessionTransferAuthenticationMethod[],
  method: SessionTransferAuthenticationMethod,
  enabled: boolean,
): SessionTransferAuthenticationMethod[] {
  return AUTHENTICATION_METHODS.filter((candidate) =>
    candidate === method ? enabled : current.includes(candidate),
  );
}

// A token in a link, with nothing tying it to the browser that asked for it,
// logs in whoever opens the link: an attacker can send their own token to sign
// a victim into the attacker's account, and a leaked link works from anywhere
// until the token expires.
export function acceptsUnboundQueryTokens(
  settings: ResolvedSessionTransfer,
): boolean {
  return (
    settings.allowed_authentication_methods.includes("query") &&
    settings.enforce_device_binding === "none"
  );
}
