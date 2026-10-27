import { useId } from "react";
import { Link } from "react-router-dom";
import { useListContext, useRecordContext } from "ra-core";
import { History, Rocket, Users } from "lucide-react";
import { BadgeField, DataTable, List, TextInput } from "@/components/admin";
import { CreateButton } from "@/components/admin/create-button";
import { ExportButton } from "@/components/admin/export-button";
import { Button } from "@/components/ui/button";
import { useHasChildren } from "@/hooks/useHasChildren";
import { getBasePath } from "@/utils/runtimeConfig";

type TenantRecord = {
  id: string;
  parent_tenant_id?: string | null;
  config_sync?: string | null;
  deployment_type?: "shared" | "wfp";
  provisioning_state?: "pending" | "ready" | "failed";
  provisioning_error?: string;
};

const stateVariant: Record<
  NonNullable<TenantRecord["provisioning_state"]>,
  "default" | "outline" | "secondary" | "destructive"
> = {
  pending: "secondary",
  ready: "outline",
  failed: "destructive",
};

function ProvisioningStateField() {
  const record = useRecordContext<TenantRecord>();
  const state = record?.provisioning_state ?? "ready";
  const errorId = useId();
  const error = record?.provisioning_error;
  return (
    <span title={error} aria-describedby={error ? errorId : undefined}>
      <BadgeField
        source="provisioning_state"
        defaultValue={state}
        variant={stateVariant[state]}
      />
      {error ? (
        <span id={errorId} className="sr-only">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function MembersLinkCell() {
  const record = useRecordContext<TenantRecord>();
  if (!record) return null;
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      onClick={(e) => e.stopPropagation()}
    >
      <Link to={`${getBasePath()}/${String(record.id)}/members`}>
        <Users className="h-4 w-4 mr-1" />
        Members
      </Link>
    </Button>
  );
}

function OperationsLinkCell() {
  const record = useRecordContext<TenantRecord>();
  if (!record) return null;
  // Plain router path — react-router prefixes the basename itself, and the
  // outer Root also renders TenantsApp for this URL on a full reload.
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      onClick={(e) => e.stopPropagation()}
    >
      <Link to={`/tenants/${String(record.id)}/operations`}>
        <History className="h-4 w-4 mr-1" />
        Operations
      </Link>
    </Button>
  );
}

function TenantListActions() {
  // Rollouts sync the tenants below the control plane. Asked of the settings
  // rather than counted from the list, which only holds the tenants this admin
  // can see.
  const hasChildren = useHasChildren();

  return (
    <div className="flex items-center gap-2">
      {hasChildren && (
        <Button asChild variant="outline" size="sm">
          <Link to="/tenants/rollouts">
            <Rocket className="h-4 w-4 mr-1" />
            Rollouts
          </Link>
        </Button>
      )}
      <CreateButton />
      <ExportButton />
    </div>
  );
}

/**
 * The table. The Parent and Config sync columns only say something once a
 * tenant has a parent or is synced, so they are left out until then.
 */
function TenantsTable() {
  const { data } = useListContext<TenantRecord>();
  const showInheritance =
    !data || data.some((t) => t.parent_tenant_id || t.config_sync === "synced");

  return (
    <DataTable
      rowClick={(_id, _resource, record) => {
        window.location.href = `${getBasePath()}/${String(record.id)}`;
        return false;
      }}
    >
      <DataTable.Col source="friendly_name" label="Name" />
      <DataTable.Col source="id" />
      <DataTable.Col source="deployment_type" label="Deployment" />
      <DataTable.Col label="Status">
        <ProvisioningStateField />
      </DataTable.Col>
      {showInheritance && (
        <DataTable.Col source="parent_tenant_id" label="Parent" />
      )}
      {showInheritance && (
        <DataTable.Col source="config_sync" label="Config sync" />
      )}
      <DataTable.Col source="audience" />
      <DataTable.Col source="support_url" label="Support URL" />
      <DataTable.Col label="">
        <MembersLinkCell />
      </DataTable.Col>
      <DataTable.Col label="">
        <OperationsLinkCell />
      </DataTable.Col>
    </DataTable>
  );
}

export function TenantsList() {
  const filters = [
    <TextInput key="q" source="q" placeholder="Search" label={false} />,
  ];

  return (
    <List
      resource="tenants"
      actions={<TenantListActions />}
      filters={filters}
      sort={{ field: "friendly_name", order: "ASC" }}
    >
      <TenantsTable />
    </List>
  );
}
