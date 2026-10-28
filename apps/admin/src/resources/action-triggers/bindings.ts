import {
  bindingTypeChoices,
  hookTemplates,
  type BindingType,
} from "../hooks/hookConstants";

export interface TriggerBinding {
  id: string;
  hook_id?: string;
  trigger_id: string;
  enabled: boolean;
  synchronous?: boolean;
  priority?: number;
  code_id?: string;
  url?: string;
  form_id?: string;
  template_id?: string;
  page_id?: string;
  permission_required?: string;
  override?: "none" | "secrets" | "fields" | null;
  enforce?: boolean | null;
}

export interface ActionRecord {
  id: string;
  name: string;
  supported_triggers?: Array<{ id?: string }>;
}

export function actionSupportsTrigger(
  action: ActionRecord,
  triggerId?: string,
) {
  return (
    !triggerId ||
    (action.supported_triggers ?? []).some(
      (trigger) =>
        (trigger.id === "post-login" ? "post-user-login" : trigger.id) ===
        triggerId,
    )
  );
}

export function bindingType(binding: TriggerBinding): BindingType | undefined {
  if (typeof binding.url === "string") return "url";
  if (typeof binding.form_id === "string") return "form";
  if (typeof binding.template_id === "string") return "template";
  if (typeof binding.code_id === "string") return "code";
  if (typeof binding.page_id === "string") return "page";
  return undefined;
}

export function bindingLabel(
  binding: TriggerBinding,
  actions: ActionRecord[],
  forms: Array<{ id: string; name?: string }>,
): string {
  switch (bindingType(binding)) {
    case "code":
      return (
        actions.find((action) => action.id === binding.code_id)?.name ??
        `Action ${binding.code_id}`
      );
    case "url":
      return binding.url!;
    case "form":
      return (
        forms.find((form) => form.id === binding.form_id)?.name ??
        `Form ${binding.form_id}`
      );
    case "template":
      return hookTemplates[binding.template_id!]?.name ?? binding.template_id!;
    case "page":
      return binding.page_id === "impersonate"
        ? "Impersonate"
        : binding.page_id!;
    default:
      return binding.hook_id ?? binding.id;
  }
}

/** Discard fields from a previously selected type when creating a binding. */
export function bindingCreatePayload(data: Record<string, unknown>) {
  const {
    type,
    code_id,
    url,
    form_id,
    template_id,
    page_id,
    permission_required,
    ...common
  } = data;
  switch (type) {
    case "code":
      return { ...common, code_id };
    case "url":
      return { ...common, url };
    case "form":
      return { ...common, form_id };
    case "template":
      return { ...common, template_id };
    case "page":
      return { ...common, page_id, permission_required };
    default:
      throw new Error("Choose a binding type");
  }
}

export const bindingGroups = [
  ...bindingTypeChoices.map((type) => ({ ...type, plural: `${type.name}s` })),
  { id: "unknown", name: "Other", plural: "Other bindings" },
];
