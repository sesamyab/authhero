import { useWatch } from "react-hook-form";
import {
  getPreScreenHookScreens,
  getPreScreenScreen,
  isPreScreenHookFailClosed,
  PRE_SCREEN_SCREENS,
} from "@authhero/adapter-interfaces";
import { AutocompleteArrayInput, BooleanInput } from "@/components/admin";

export function isPreScreenTrigger(triggerId: unknown): boolean {
  return triggerId === "pre-screen";
}

/** Screen choices, labelled with the name the action sees. */
export const PRE_SCREEN_CHOICES = PRE_SCREEN_SCREENS.map((screen) => ({
  id: screen.name,
  name: `${screen.name} — ${screen.description}`,
}));

function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

/** "All screens" or the selected screen names, plus the failure mode. */
export function describePreScreenBinding(metadata: unknown): string {
  const meta = asMetadata(metadata);
  const screens = getPreScreenHookScreens(meta);
  const which = screens
    ? screens
        .map((name) => (getPreScreenScreen(name) ? name : `${name} (unknown)`))
        .join(", ")
    : "All screens";
  return isPreScreenHookFailClosed(meta)
    ? `${which}; fails closed on render`
    : which;
}

/**
 * AuthHero extension on `pre-screen` bindings: the screens the action runs
 * for (`metadata.screens`) and whether a failing action blocks the screen in
 * the render phase too (`metadata.fail_closed`).
 */
export function PreScreenBindingInputs() {
  const triggerId = useWatch({ name: "trigger_id" });
  if (!isPreScreenTrigger(triggerId)) return null;
  return (
    <>
      <AutocompleteArrayInput
        source="metadata.screens"
        label="Screens this action runs for"
        choices={PRE_SCREEN_CHOICES}
        helperText="Leave empty to run on every screen. The action runs before the screen is shown and again when it is submitted."
      />
      <BooleanInput
        source="metadata.fail_closed"
        label="Block the screen if the action fails while rendering"
        helperText="Submissions are always blocked when the action fails. Off: a failure before showing the screen is logged and the screen is shown."
      />
    </>
  );
}
