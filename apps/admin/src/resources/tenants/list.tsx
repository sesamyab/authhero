import { useId } from "react";
import { Link, Navigate } from "react-router-dom";
import { ListBase, useListContext, useRecordContext } from "ra-core";
import { History, Rocket, Users } from "lucide-react";
import { BadgeField, DataTable, TextInput } from "@/components/admin";
import { ListView } from "@/components/admin/list";
import { Loading } from "@/components/admin/loading";
import { CreateButton } from "@/components/admin/create-button";
import { ExportButton } from "@/components/admin/export-button";
import { JsonActionsButton } from "@/components/JsonActionsButton";
import { Button } from "@/components/ui/button";
import { useHasChildren } from "@/hooks/useHasChildren";
import { useManagementPermissions } from "@/hooks/useManagementPermissions";
import { getBasePath } from "@/utils/runtimeConfig";
import { TenantsEmptyState } from "./empty-state";

/**
 * The tenant to show the setup page of: a user's first and only tenant while
 * it is being set up, which is all there is to look at. Anything else keeps
 * the list, so a failed tenant, or more than one, stays reachable there with
 * its operations and Create.
 */
export function onboardingTenant(
  rows: TenantRecord[],
  total: number | undefined,
): TenantRecord | undefined {
  if (rows.length !== 1 || (total ?? 1) !== 1) return;
  const [only] = rows;
  return only?.provisioning_state === "pending" ? only : undefined;
}

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

function TenantListActions({
  hasChildren,
  canCreate,
}: {
  hasChildren: boolean;
  canCreate: boolean;
}) {
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
      {canCreate && <CreateButton />}
      <ExportButton />
      <JsonActionsButton size="default" />
    </div>
  );
}

/**
 * The table. The Parent and Config sync columns are left out only while the
 * control plane has no other tenant. They do not depend on the rows of the
 * current page, so they stay put across pages and filters and while a child
 * tenant is being set up.
 */
function TenantsTable({ showInheritance }: { showInheritance: boolean }) {
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

const filters = [
  <TextInput key="q" source="q" placeholder="Search" label={false} />,
];

/**
 * The list, or the empty state when the user has no tenants at all. A search
 * that matches nothing keeps the list and its "no results".
 */
function TenantsListContent() {
  const { isPending, error, data, total, filterValues } = useListContext();
  const rowCount: number = data?.length ?? 0;
  const { loading, can } = useManagementPermissions();
  const canCreate = can("create:tenants");
  // Rollouts sync the tenants below the control plane. Asked of the settings
  // rather than counted from the list, which only holds the tenants this admin
  // can see. Without `read:tenants` the settings are refused, so not asked.
  const hasChildren = useHasChildren({
    enabled: !loading && can("read:tenants"),
  });

  const isFiltered = Object.keys(filterValues ?? {}).length > 0;
  // Until both answers are in it is not known whether this is the list or
  // the empty state; showing the list meanwhile flashes it at a new user.
  // A search keeps the list, which renders its own loading state. Loading
  // shows only if it takes long.
  if ((isPending || loading) && !isFiltered && !error) return <Loading />;
  const isEmpty = total === 0 || (total === undefined && rowCount === 0);
  if (!error && isEmpty && !isFiltered) {
    return <TenantsEmptyState canCreate={canCreate} />;
  }
  // A user whose only tenants are not ready has nothing to pick from a list:
  // take them to where theirs is being set up.
  const settingUp =
    !error && !isFiltered
      ? onboardingTenant((data ?? []) as TenantRecord[], total)
      : undefined;
  if (settingUp) {
    return (
      <Navigate
        to={`/tenants/${encodeURIComponent(String(settingUp.id))}/setup`}
        replace
      />
    );
  }

  return (
    <ListView
      actions={
        <TenantListActions hasChildren={hasChildren} canCreate={canCreate} />
      }
      filters={filters}
    >
      <TenantsTable showInheritance={hasChildren} />
    </ListView>
  );
}

export function TenantsList() {
  return (
    <ListBase
      resource="tenants"
      sort={{ field: "friendly_name", order: "ASC" }}
    >
      <TenantsListContent />
    </ListBase>
  );
}
