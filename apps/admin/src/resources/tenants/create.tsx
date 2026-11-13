import { useEffect, useRef } from "react";
import {
  CreateBase,
  useCreate,
  useGetList,
  useInput,
  useNotify,
} from "ra-core";
import { useFormContext, useWatch } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { Building2, Database, Server } from "lucide-react";
import { Create, SimpleForm, TextInput } from "@/components/admin";
import { SaveButton } from "@/components/admin/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  TenantDeploymentOptions,
  TenantDeploymentType,
} from "@/auth0DataProvider";
import { cn } from "@/lib/utils";
import { httpStatusOf } from "@/utils/httpStatus";
import {
  tenantHost,
  useDeploymentOptions,
  validateTenantId,
} from "./deployment";

const deploymentTypes: Record<
  TenantDeploymentType,
  { label: string; description: string; icon: typeof Database }
> = {
  shared: {
    label: "Shared",
    description: "Runs in the shared database. Ready right away.",
    icon: Database,
  },
  wfp: {
    label: "Dispatch worker (WFP)",
    description: "Gets its own worker and D1 database when it is created.",
    icon: Server,
  },
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Auto-suggests the tenant id (slug) from the name until the user edits it.
function SlugInput({ hostTemplate }: { hostTemplate?: string }) {
  const { setValue } = useFormContext();
  const name = useWatch({ name: "friendly_name" }) as string | undefined;
  const id = useWatch({ name: "id" }) as string | undefined;
  const edited = useRef(false);

  useEffect(() => {
    if (edited.current) return;
    setValue("id", slugify(name ?? ""));
  }, [name, setValue]);

  return (
    <TextInput
      source="id"
      label="ID"
      // The id is a hostname label, so case can only be wrong: lowercase it
      // as it is typed. Other characters are left for the validator to flag.
      parse={(value: string) => value.toLowerCase()}
      validate={validateTenantId}
      // The rules up front, so they are read before they are broken.
      helperText={`${
        hostTemplate
          ? `Your tenant will be at ${tenantHost(hostTemplate, id ?? "")}.`
          : "Lowercase letters, digits and hyphens."
      } Can't be changed later.`}
      // react-hook-form's field spread overrides any onChange we pass (see
      // text-input.tsx), so signal user intent via onFocus instead — which the
      // field object doesn't provide and therefore survives the spread.
      onFocus={() => {
        edited.current = true;
      }}
    />
  );
}

// Whether the user can see any tenant to inherit from. A first tenant has
// none, so the field would only raise a question.
// Undefined until the list has answered.
function useHasOtherTenants(): boolean | undefined {
  const { total, data, isPending } = useGetList("tenants", {
    pagination: { page: 1, perPage: 1 },
  });
  if (isPending) return undefined;
  return (total ?? data?.length ?? 0) > 0;
}

/**
 * The onboarding card's one action, in place of the sticky toolbar. No way
 * back: the empty state before it only leads here.
 */
function OnboardingToolbar() {
  return (
    <div className="pt-2">
      <SaveButton label="Create tenant" className="w-full" />
    </div>
  );
}

/**
 * Field errors for a refused create. The server answers 400 or 409 with a
 * message about the id (taken, reserved, not a DNS label); anything else is
 * not the form's to show.
 */
export function createErrorToFieldErrors(
  error: unknown,
): Record<string, string> | undefined {
  const code = httpStatusOf(error);
  if (code !== 400 && code !== 409) return undefined;
  const { message, body } = error as {
    message?: string;
    body?: { message?: string };
  };
  const text = body?.message ?? message;
  return text ? { id: text } : undefined;
}

function DeploymentTypeCards({
  options,
}: {
  options: TenantDeploymentOptions;
}) {
  const { field } = useInput({
    source: "deployment_type",
    defaultValue: options.default_deployment_type,
  });
  const selected: TenantDeploymentType =
    field.value === "shared" || field.value === "wfp"
      ? field.value
      : options.default_deployment_type;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium" id="deployment-type-label">
        Deployment
      </span>
      <div
        role="radiogroup"
        aria-labelledby="deployment-type-label"
        className="grid grid-cols-2 gap-3"
      >
        {options.deployment_types.map((type) => {
          const { label, description, icon: Icon } = deploymentTypes[type];
          const isSelected = type === selected;
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => field.onChange(type)}
              className={cn(
                "flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors",
                "hover:border-primary hover:bg-accent",
                isSelected && "border-primary bg-accent ring-1 ring-primary",
              )}
            >
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="text-sm font-medium">{label}</span>
                {type === options.default_deployment_type && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    Default
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DeploymentFields({ options }: { options: TenantDeploymentOptions }) {
  // With one type there is nothing to choose; say what the tenant gets.
  if (options.deployment_types.length > 1) {
    return <DeploymentTypeCards options={options} />;
  }
  return options.default_deployment_type === "wfp" ? (
    <p className="text-sm text-muted-foreground">
      A dedicated D1 database (Drizzle) will be provisioned for this tenant.
    </p>
  ) : null;
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
  const hasOtherTenants = useHasOtherTenants();
  const [create] = useCreate();
  const navigate = useNavigate();
  const notify = useNotify();

  // Saved here rather than by <Create> so a refusal about the id lands on the
  // id field, and a created tenant opens on its setup page while it provisions.
  const save = async (values: Record<string, unknown>) => {
    try {
      const { id } = await create(
        "tenants",
        { data: createTransform(deploymentOptions)(values) },
        { returnPromise: true },
      );
      navigate(`/tenants/${encodeURIComponent(String(id))}/setup`);
      return undefined;
    } catch (error) {
      const fieldErrors = createErrorToFieldErrors(error);
      if (fieldErrors) return fieldErrors;
      notify(
        error instanceof Error ? error.message : "Could not create the tenant",
        {
          type: "error",
        },
      );
      return undefined;
    }
  };

  const fields = (
    <>
      <TextInput
        source="friendly_name"
        label="Name"
        placeholder="Acme Inc."
        required
      />
      <SlugInput hostTemplate={deploymentOptions?.tenant_host_template} />
      {deploymentOptions && <DeploymentFields options={deploymentOptions} />}
      {hasOtherTenants && (
        <TextInput
          source="parent_tenant_id"
          label="Parent tenant"
          helperText="Optional. The tenant this one inherits config from; empty means the control plane."
        />
      )}
    </>
  );

  // Which layout is not known until the list answers; wait rather than
  // flash one and switch to the other.
  if (hasOtherTenants === undefined) return null;

  // A user with no tenant is onboarding: the form sits in a centred card like
  // the empty state before it and the setup page after it.
  if (!hasOtherTenants) {
    return (
      <CreateBase>
        <div className="flex min-h-[60vh] items-center justify-center p-4">
          <Card className="w-full max-w-lg">
            <CardHeader className="items-center text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Building2 className="h-6 w-6" aria-hidden />
              </div>
              <CardTitle>Create your first tenant</CardTitle>
              <CardDescription>Give it a name to get started.</CardDescription>
            </CardHeader>
            <CardContent>
              <SimpleForm
                onSubmit={save}
                toolbar={<OnboardingToolbar />}
                className="max-w-none"
              >
                {fields}
              </SimpleForm>
            </CardContent>
          </Card>
        </div>
      </CreateBase>
    );
  }

  return (
    <Create>
      <SimpleForm onSubmit={save}>{fields}</SimpleForm>
    </Create>
  );
}
