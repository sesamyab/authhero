/**
 * What a row change means, shared by the views of a sync, a detach and a
 * verification so the same meaning has the same colour everywhere.
 */
export type ChangeTone = "add" | "change" | "remove" | "convert" | "keep";

export const CHANGE_TONE_CLASS: Record<ChangeTone, string> = {
  add: "border-green-600/30 bg-green-50 text-green-800 dark:border-green-500/30 dark:bg-green-950 dark:text-green-300",
  change:
    "border-amber-600/30 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-950 dark:text-amber-300",
  remove:
    "border-red-600/30 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-950 dark:text-red-300",
  convert:
    "border-sky-600/30 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-950 dark:text-sky-300",
  keep: "text-muted-foreground",
};
