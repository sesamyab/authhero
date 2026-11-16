import type { ReactNode } from "react";
import { useInput } from "ra-core";
import { useWatch } from "react-hook-form";
import { TriangleAlert } from "lucide-react";
import {
  SESSION_TRANSFER_DEFAULTS,
  resolveSessionTransfer,
  type SessionTransferAuthenticationMethod,
  type SessionTransferDeviceBinding,
} from "@authhero/adapter-interfaces";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  AUTHENTICATION_METHODS,
  DEVICE_BINDINGS,
  acceptsUnboundQueryTokens,
  isDeviceBinding,
  toggleAuthenticationMethod,
} from "./sessionTransfer";

type BooleanSetting =
  | "can_create_session_transfer_token"
  | "enforce_cascade_revocation"
  | "allow_onward_transfer"
  | "trust_forwarded_ip"
  | "allow_refresh_token"
  | "enforce_online_refresh_tokens";

// Not a BooleanInput: that one shows an unset field as off and writes `false`
// into it on save. Two of these settings default to on, so a client that never
// configured session transfer would have them silently turned off. This shows
// the API's default for an unset field and only writes when toggled.
function SettingSwitch({
  name,
  label,
  extension = false,
  children,
}: {
  name: BooleanSetting;
  label: string;
  extension?: boolean;
  children: ReactNode;
}) {
  const { field } = useInput({ source: `session_transfer.${name}` });
  const checked =
    typeof field.value === "boolean"
      ? field.value
      : SESSION_TRANSFER_DEFAULTS[name];
  const id = `session-transfer-${name}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch id={id} checked={checked} onCheckedChange={field.onChange} />
        <Label htmlFor={id}>{label}</Label>
        {extension && <Badge variant="outline">AuthHero extension</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

const METHOD_LABELS: Record<SessionTransferAuthenticationMethod, string> = {
  cookie: "Cookie (auth0_session_transfer_token)",
  query: "Query parameter (session_transfer_token)",
};

function AuthenticationMethodsInput({
  selected,
}: {
  selected: readonly SessionTransferAuthenticationMethod[];
}) {
  const { field } = useInput({
    source: "session_transfer.allowed_authentication_methods",
  });

  return (
    <div className="flex flex-col gap-2">
      <Label>Accept a token sent as</Label>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {AUTHENTICATION_METHODS.map((method) => {
          const id = `session-transfer-method-${method}`;
          return (
            <label
              key={method}
              htmlFor={id}
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id={id}
                checked={selected.includes(method)}
                onCheckedChange={(value) =>
                  field.onChange(
                    toggleAuthenticationMethod(
                      selected,
                      method,
                      value === true,
                    ),
                  )
                }
              />
              {METHOD_LABELS[method]}
            </label>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">
        How /authorize accepts a session transfer token for this application.
        With neither ticked, the application ignores them and users log in as
        usual.
      </p>
    </div>
  );
}

const DEVICE_BINDING_OPTIONS: Record<
  SessionTransferDeviceBinding,
  { label: string; description: string }
> = {
  ip: {
    label: "Same IP address",
    description:
      "The browser must redeem the token from the IP address that requested it. A user whose requests alternate between IPv4 and IPv6 is sent to the login page.",
  },
  asn: {
    label: "Same network (ASN)",
    description:
      "The browser must be on the same provider network as the request that created the token. Needs a runtime that reports the ASN, such as Cloudflare Workers; without one every token is refused.",
  },
  none: {
    label: "No check",
    description: "The token can be redeemed from anywhere.",
  },
};

function DeviceBindingInput({
  value,
}: {
  value: SessionTransferDeviceBinding;
}) {
  const { field } = useInput({
    source: "session_transfer.enforce_device_binding",
  });

  return (
    <div className="flex flex-col gap-2">
      <Label>Device binding</Label>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (isDeviceBinding(next)) field.onChange(next);
        }}
      >
        {DEVICE_BINDINGS.map((binding) => {
          const id = `session-transfer-binding-${binding}`;
          const option = DEVICE_BINDING_OPTIONS[binding];
          return (
            <div key={binding} className="flex items-start gap-2">
              <RadioGroupItem id={id} value={binding} className="mt-0.5" />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={id}>{option.label}</Label>
                <p className="text-sm text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}

export function SessionTransferTab() {
  const stored: unknown = useWatch({ name: "session_transfer" });
  const settings = resolveSessionTransfer(stored);
  const receives = settings.allowed_authentication_methods.length > 0;

  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Session transfer carries a signed-in user from one application to
        another in this tenant without a second login, including between sites
        on different top-level domains. The sending application exchanges its
        refresh token for a single-use token that is valid for 60 seconds, and
        the receiving application passes that token to /authorize.
      </p>

      <h3 className="text-base font-semibold mt-2">Sending</h3>
      <SettingSwitch
        name="can_create_session_transfer_token"
        label="Create session transfer tokens"
      >
        Let this application exchange a refresh token for a session transfer
        token at /oauth/token. The application needs a refresh token, so its
        users must log in with the offline_access scope.
      </SettingSwitch>
      {settings.can_create_session_transfer_token && (
        <>
          <SettingSwitch
            name="enforce_cascade_revocation"
            label="Cascade revocation"
          >
            Revoking the refresh token a transfer started from also ends the
            sessions created from it, and the refresh tokens issued in those
            sessions.
          </SettingSwitch>
          <SettingSwitch
            name="trust_forwarded_ip"
            label="Trust forwarded IP address"
            extension
          >
            Turn on when this application&apos;s backend makes the exchange, and
            send the user&apos;s IP address in the auth0-forwarded-for header.
            Without it the token is bound to the backend&apos;s address and a
            receiving application that checks the IP address refuses it. The
            header is only honoured on requests authenticated with a client
            secret or assertion.
          </SettingSwitch>
          <SettingSwitch
            name="allow_onward_transfer"
            label="Allow onward transfer"
            extension
          >
            Let a login that itself arrived by session transfer be passed on to
            a third application. Every hop stays tied to the refresh token the
            chain started from.
          </SettingSwitch>
        </>
      )}

      <h3 className="text-base font-semibold mt-2">Receiving</h3>
      <AuthenticationMethodsInput
        selected={settings.allowed_authentication_methods}
      />
      {receives && (
        <>
          <DeviceBindingInput value={settings.enforce_device_binding} />
          {acceptsUnboundQueryTokens(settings) && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Links can log anyone in</AlertTitle>
              <AlertDescription>
                With tokens accepted in the URL and no device check, anyone who
                opens a link carrying a valid token is logged in as its user. An
                attacker can send their own link to sign someone into the
                attacker&apos;s account, and a leaked link works from anywhere
                until the token is used or expires. Keep a device check on, or
                accept the cookie only.
              </AlertDescription>
            </Alert>
          )}
          <SettingSwitch
            name="allow_refresh_token"
            label="Issue refresh tokens"
          >
            Let a login that arrived by session transfer receive a refresh token
            when it asks for offline_access. When off, the login still succeeds,
            without a refresh token.
          </SettingSwitch>
          {settings.allow_refresh_token && (
            <SettingSwitch
              name="enforce_online_refresh_tokens"
              label="Bind refresh tokens to the session"
            >
              Those refresh tokens stop working when the transferred session
              ends or expires, and using one keeps the session alive.
            </SettingSwitch>
          )}
        </>
      )}
    </div>
  );
}
