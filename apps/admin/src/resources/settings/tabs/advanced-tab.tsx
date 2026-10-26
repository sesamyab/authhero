import { useState } from "react";
import { Trash } from "lucide-react";
import { useDelete, useNotify, useRecordContext } from "ra-core";
import {
  ArrayInput,
  BooleanInput,
  SelectInput,
  SimpleFormIterator,
  TextInput,
} from "@/components/admin";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/admin/confirm";
import { useTenantId } from "@/TenantContext";
import { getBasePath } from "@/utils/runtimeConfig";

interface TenantSettingsRecord {
  id?: string;
  is_control_plane?: boolean;
}

const CONFIG_SYNC_CHOICES = [
  { id: "inherit-on-read", name: "Inherit on read" },
  { id: "synced", name: "Synced" },
];

/**
 * How the tenant gets config inherited from the control plane. The control
 * plane itself has nothing to inherit, so it does not show the field. The
 * server only lets a control-plane credential change it.
 */
function ConfigSyncInput() {
  const record = useRecordContext<TenantSettingsRecord>();
  if (record?.is_control_plane) return null;

  return (
    <SelectInput
      source="config_sync"
      label="Config sync"
      choices={CONFIG_SYNC_CHOICES}
      defaultValue="inherit-on-read"
      helperText="Inherit on read: connections, hooks, email provider and system API scopes are merged in from the control plane at request time. Synced: only this tenant's own database is read; sync the control plane's config into it first. Only the control plane can change this."
    />
  );
}

function DeleteTenantSection() {
  const tenantId = useTenantId();
  const record = useRecordContext<TenantSettingsRecord>();
  const [open, setOpen] = useState(false);
  const [deleteOne, { isPending }] = useDelete();
  const notify = useNotify();

  if (!tenantId || record?.is_control_plane) return null;

  const handleConfirm = () => {
    deleteOne(
      "tenants",
      { id: tenantId, previousData: record ?? { id: tenantId } },
      {
        onSuccess: () => {
          setOpen(false);
          notify(`Tenant "${tenantId}" deleted`, { type: "info" });
          window.location.href = `${getBasePath()}/tenants`;
        },
        onError: (error) => {
          setOpen(false);
          const message =
            error instanceof Error ? error.message : "Failed to delete tenant";
          notify(message, { type: "error" });
        },
      },
    );
  };

  return (
    <div className="mt-6 rounded-md border border-destructive/40 p-4">
      <h3 className="text-base font-semibold text-destructive">Danger zone</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Permanently delete this tenant and all its data, including any
        provisioned worker or database. This cannot be undone.
      </p>
      <Button
        variant="destructive"
        type="button"
        className="mt-3"
        disabled={isPending}
        onClick={() => setOpen(true)}
      >
        <Trash className="size-4" />
        Delete tenant
      </Button>
      <Confirm
        isOpen={open}
        title={`Delete tenant "${tenantId}"?`}
        content="This will permanently remove the tenant and trigger deprovisioning of any associated infrastructure. This action cannot be undone."
        confirm="Delete tenant"
        confirmColor="warning"
        ConfirmIcon={Trash}
        onConfirm={handleConfirm}
        onClose={() => setOpen(false)}
        loading={isPending}
      />
    </div>
  );
}

export function AdvancedTab() {
  return (
    <div className="flex flex-col gap-3">
      <BooleanInput
        source="oidc_logout.rp_logout_end_session_endpoint_discovery"
        label="RP-Initiated Logout End Session Endpoint Discovery"
        helperText="Advertise end_session_endpoint in /.well-known/openid-configuration. Required for RP-Initiated Logout (OpenID Connect Session Management). Off by default."
        defaultValue={false}
      />
      <TextInput source="sandbox_version" label="Sandbox Version" />
      <ArrayInput
        source="sandbox_versions_available"
        label="Available Sandbox Versions"
      >
        <SimpleFormIterator inline>
          <TextInput source="" label="" />
        </SimpleFormIterator>
      </ArrayInput>
      <ConfigSyncInput />
      <DeleteTenantSection />
    </div>
  );
}
