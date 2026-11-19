import { Bindings } from "../types";

type FromAddressInput = {
  env: Pick<Bindings, "ISSUER" | "DEFAULT_SENDER_EMAIL">;
  provider?: { default_from_address?: string | null } | null;
  tenant?: {
    sender_email?: string | null;
    sender_name?: string | null;
    friendly_name?: string | null;
  } | null;
};

function hostnameOf(issuer: string): string {
  try {
    return new URL(issuer).hostname;
  } catch {
    // ISSUER should be a URL, but tolerate a bare host.
    return issuer.replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
  }
}

/**
 * The `from` address when the template does not set one, in order:
 * the email provider's `default_from_address`, the tenant's `sender_email`
 * (with `sender_name`, else `friendly_name`), the `DEFAULT_SENDER_EMAIL`
 * binding, and last `login@<issuer host>`. `ISSUER` is a full URL, so only
 * its hostname is used.
 */
export function resolveFromAddress({
  env,
  provider,
  tenant,
}: FromAddressInput): string {
  if (provider?.default_from_address) {
    return provider.default_from_address;
  }

  if (tenant?.sender_email) {
    const name = tenant.sender_name || tenant.friendly_name;
    return name ? `${name} <${tenant.sender_email}>` : tenant.sender_email;
  }

  return env.DEFAULT_SENDER_EMAIL || `login@${hostnameOf(env.ISSUER)}`;
}
