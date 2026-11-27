import { useEffect, useState } from "react";
import { useInput, useRecordContext } from "ra-core";
import { useFormContext } from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";
import {
  BooleanInput,
  DateField,
  SelectInput,
  TextArrayInput,
  TextInput,
} from "@/components/admin";
import { SecretInput } from "@/common/SecretInput";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useClientShape } from "../use-client-shape";

const GRANT_TYPE_CHOICES = [
  { id: "implicit", name: "Implicit" },
  { id: "authorization_code", name: "Authorization Code" },
  { id: "refresh_token", name: "Refresh Token" },
  { id: "urn:ietf:params:oauth:grant-type:device_code", name: "Device Code" },
  { id: "client_credentials", name: "Client Credentials" },
  { id: "password", name: "Password" },
  { id: "mfa", name: "MFA" },
  {
    id: "http://auth0.com/oauth/grant-type/passwordless/otp",
    name: "Passwordless OTP",
  },
  {
    id: "urn:ietf:params:oauth:grant-type:token-exchange",
    name: "Token Exchange",
  },
];

// Short ids this form saved before it switched to the canonical wire values
// the token endpoint compares against. Stored values are folded into their
// wire form on read, so old records render checked and migrate on the next
// save. The token endpoint accepts both, so nothing breaks in between.
const LEGACY_GRANT_TYPE_IDS: Record<string, string> = {
  device_code: "urn:ietf:params:oauth:grant-type:device_code",
  passwordless_otp: "http://auth0.com/oauth/grant-type/passwordless/otp",
};

const EMAIL_VALIDATION_CHOICES = [
  { id: "disabled", name: "Disabled" },
  { id: "enabled", name: "Enabled" },
  { id: "enforced", name: "Enforced" },
];

// Per-client override of the tenant's login version. Radix
// Select can't hold an empty value, so "inherit" stands in for "no key" in the
// UI and is parsed back to "" (which the edit transform drops on save).
const LOGIN_VERSION_INHERIT = "inherit";
const LOGIN_VERSION_CHOICES = [
  { id: LOGIN_VERSION_INHERIT, name: "Inherit from tenant" },
  { id: "1", name: "Classic (/u)" },
  { id: "2", name: "New (/u2)" },
];

// client_metadata keys that have dedicated inputs on this tab.
const KEPT_METADATA_KEYS = [
  "email_validation",
  "tos_uri",
  "policy_uri",
  "universal_login_version",
];

// Free-form key/value rows of client_metadata. `email_validation` is rendered
// separately as a SelectInput above, so it's filtered out here. The legacy
// `disable_sign_ups` key (now stored on the connection) is filtered out so
// old records don't show it twice during a partial migration.
export function ClientMetadataInput() {
  const { field } = useInput({ source: "client_metadata" });
  const { getValues } = useFormContext();
  const record = useRecordContext();
  const value: Record<string, unknown> =
    field.value && typeof field.value === "object" ? field.value : {};

  const reserved = new Set([...KEPT_METADATA_KEYS, "disable_sign_ups"]);

  const [rows, setRows] = useState<Array<{ key: string; value: string }>>([]);

  useEffect(() => {
    const next = Object.entries(value)
      .filter(([k]) => !reserved.has(k))
      .map(([k, v]) => ({ key: k, value: v == null ? "" : String(v) }));
    setRows(next);
    // value is intentionally not in deps — we only seed the local rows from the
    // form state once per record load; subsequent edits flow through commit().
  }, [field.name, record?.id]);

  const commit = (next: Array<{ key: string; value: string }>) => {
    const out: Record<string, unknown> = {};
    // Keys edited by their own inputs above are not rows; carry them over so
    // editing a row doesn't drop them from the saved metadata. Read the live
    // form value: `value` from this render can predate an edit made in one of
    // those inputs.
    const current = getValues("client_metadata");
    const latest: Record<string, unknown> =
      current && typeof current === "object" ? current : {};
    for (const key of KEPT_METADATA_KEYS) {
      if (key in latest) out[key] = latest[key];
    }
    for (const row of next) {
      const k = row.key.trim();
      if (k) out[k] = row.value;
    }
    field.onChange(out);
  };

  const handleChange = (
    i: number,
    field: "key" | "value",
    newValue: string,
  ) => {
    const next = rows.map((row, idx) =>
      idx === i ? { ...row, [field]: newValue } : row,
    );
    setRows(next);
    commit(next);
  };

  const handleAdd = () => {
    const next = [...rows, { key: "", value: "" }];
    setRows(next);
  };

  const handleRemove = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    commit(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>Application Metadata</Label>
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={row.key}
            placeholder="Key"
            onChange={(e) => handleChange(i, "key", e.target.value)}
            className="max-w-xs"
          />
          <Input
            value={row.value}
            placeholder="Value"
            onChange={(e) => handleChange(i, "value", e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Remove metadata entry"
            onClick={() => handleRemove(i)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-1" />
          Add metadata
        </Button>
      </div>
    </div>
  );
}

function GrantTypesInput() {
  const { field } = useInput({ source: "grant_types" });
  const selected: string[] = Array.isArray(field.value)
    ? field.value.map(
        (granted: string) => LEGACY_GRANT_TYPE_IDS[granted] ?? granted,
      )
    : [];

  const toggle = (id: string, checked: boolean) => {
    const next = checked ? [...selected, id] : selected.filter((g) => g !== id);
    field.onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>Grant Types</Label>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {GRANT_TYPE_CHOICES.map((choice) => {
          const id = `grant-type-${choice.id}`;
          return (
            <label
              key={choice.id}
              htmlFor={id}
              className="flex items-center gap-2 text-sm"
            >
              <Checkbox
                id={id}
                checked={selected.includes(choice.id)}
                onCheckedChange={(v) => toggle(choice.id, v === true)}
              />
              {choice.name}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Timestamps() {
  const record = useRecordContext();
  if (!record) return null;
  return (
    <div className="grid grid-cols-2 gap-4 mt-2">
      <div>
        <Label className="text-xs text-muted-foreground">Created at</Label>
        <div className="text-sm">
          <DateField source="created_at" showTime />
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Updated at</Label>
        <div className="text-sm">
          <DateField source="updated_at" showTime />
        </div>
      </div>
    </div>
  );
}

export function DetailsTab() {
  const shape = useClientShape();
  return (
    <div className="flex flex-col gap-3">
      <TextInput source="id" readOnly />
      <TextInput source="name" />
      {shape.showSecret && <SecretInput source="client_secret" />}
      <BooleanInput
        source="auth0_conformant"
        label="Auth0 Conformant Mode"
        helperText="Enable Auth0-compatible behavior. Disable for strict OIDC compliance."
        defaultValue={true}
      />
      {shape.isInteractive && (
        <>
          <BooleanInput
            source="hide_sign_up_disabled_error"
            label="Hide sign-up-disabled error (enumeration-safe)"
            helperText="When the password connection has disable_signup=true, suppress the explicit account-does-not-exist error and let the OTP/password challenge fail generically. Mitigates email enumeration at the cost of UX clarity."
          />
          <SelectInput
            source="client_metadata.email_validation"
            label="Email validation"
            choices={EMAIL_VALIDATION_CHOICES}
            defaultValue="disabled"
          />
          <SelectInput
            source="client_metadata.universal_login_version"
            label="Login version"
            choices={LOGIN_VERSION_CHOICES}
            format={(v) => v || LOGIN_VERSION_INHERIT}
            parse={(v) => (v === LOGIN_VERSION_INHERIT ? "" : v)}
            helperText="Which login pages this application uses. Inherit follows the tenant setting (Settings → Feature Flags → Use the widget login)."
          />
          <TextInput
            source="client_metadata.tos_uri"
            label="Terms of service URL"
            helperText="Shown as a link on the login page. Overrides the tenant default (Branding → Legal links). Falls back to the older termsAndConditionsUrl metadata key."
          />
          <TextInput
            source="client_metadata.policy_uri"
            label="Privacy policy URL"
            helperText="Shown as a link on the login page. Overrides the tenant default (Branding → Legal links)."
          />
        </>
      )}
      <ClientMetadataInput />
      <GrantTypesInput />
      {shape.showCallbacks && (
        <>
          <TextArrayInput source="callbacks" label="Callbacks" />
          <TextArrayInput
            source="allowed_logout_urls"
            label="Allowed Logout URLs"
          />
          <TextArrayInput source="web_origins" label="Web Origins" />
        </>
      )}
      <TextArrayInput source="allowed_clients" label="Allowed Clients" />
      <Timestamps />
    </div>
  );
}
