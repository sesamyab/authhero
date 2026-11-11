import { useEffect, useRef, useState } from "react";
import { useDataProvider } from "ra-core";
import { useFormContext, useWatch } from "react-hook-form";
import {
  Create,
  RadioButtonGroupInput,
  SimpleForm,
  TextInput,
} from "@/components/admin";
import type {
  AuthHeroDataProvider,
  TenantDeploymentOptions,
  TenantDeploymentType,
} from "@/auth0DataProvider";

const deploymentTypeLabels: Record<TenantDeploymentType, string> = {
  shared: "Shared",
  wfp: "Dispatch worker (WFP)",
};

// What a server without the deployment-options endpoint allows.
const legacyDeploymentOptions: TenantDeploymentOptions = {
  deployment_types: ["shared", "wfp"],
  default_deployment_type: "shared",
};

// Asks the server which deployment types it can host, so a cluster without a
// shared database (WFP only) doesn't offer "shared".
function useDeploymentOptions(): TenantDeploymentOptions | undefined {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const [options, setOptions] = useState<TenantDeploymentOptions>();

  useEffect(() => {
    let cancelled = false;
    dataProvider
      .getTenantDeploymentOptions()
      .then((result) => {
        if (!cancelled) setOptions(result ?? legacyDeploymentOptions);
      })
      .catch(() => {
        // The server still enforces what it allows; fall back to the choice.
        if (!cancelled) setOptions(legacyDeploymentOptions);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider]);

  return options;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Auto-suggests the tenant id (slug) from the name until the user edits it.
function SlugInput() {
  const { setValue } = useFormContext();
  const name = useWatch({ name: "friendly_name" }) as string | undefined;
  const edited = useRef(false);

  useEffect(() => {
    if (edited.current) return;
    setValue("id", slugify(name ?? ""));
  }, [name, setValue]);

  return (
    <TextInput
      source="id"
      label="Id"
      // react-hook-form's field spread overrides any onChange we pass (see
      // text-input.tsx), so signal user intent via onFocus instead — which the
      // field object doesn't provide and therefore survives the spread.
      onFocus={() => {
        edited.current = true;
      }}
    />
  );
}

function DeploymentFields({ options }: { options: TenantDeploymentOptions }) {
  const watched: unknown = useWatch({ name: "deployment_type" });
  const deploymentType =
    watched === "shared" || watched === "wfp"
      ? watched
      : options.default_deployment_type;
  const choices = options.deployment_types.map((id) => ({
    id,
    name:
      id === options.default_deployment_type &&
      options.deployment_types.length > 1
        ? `${deploymentTypeLabels[id]} (default)`
        : deploymentTypeLabels[id],
  }));

  return (
    <>
      {choices.length > 1 && (
        <RadioButtonGroupInput
          source="deployment_type"
          choices={choices}
          defaultValue={options.default_deployment_type}
        />
      )}
      {deploymentType === "wfp" && (
        <p className="text-sm text-muted-foreground">
          A dedicated D1 database (Drizzle) will be provisioned for this tenant.
        </p>
      )}
    </>
  );
}

// Dispatch worker tenants always get their own D1 provisioned with Drizzle.
function createTransform(options: TenantDeploymentOptions | undefined) {
  return (data: Record<string, unknown>) => {
    const deploymentType =
      data.deployment_type ?? options?.default_deployment_type;
    if (deploymentType === undefined) return data;
    if (deploymentType !== "wfp") {
      return { ...data, deployment_type: deploymentType };
    }
    return {
      ...data,
      deployment_type: deploymentType,
      storage_kind: "own_d1",
      bundle_configuration: "authhero-drizzle-d1",
    };
  };
}

export function TenantsCreate() {
  const deploymentOptions = useDeploymentOptions();

  return (
    <Create transform={createTransform(deploymentOptions)}>
      <SimpleForm>
        <TextInput source="friendly_name" label="Name" required />
        <SlugInput />
        {deploymentOptions && <DeploymentFields options={deploymentOptions} />}
        <TextInput
          source="parent_tenant_id"
          label="Parent tenant"
          helperText="Optional. The tenant this one inherits config from; empty means the control plane."
        />
      </SimpleForm>
    </Create>
  );
}
