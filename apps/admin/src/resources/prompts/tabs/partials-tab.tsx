import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataProvider, useNotify } from "ra-core";
import {
  ArrowUpDown,
  ChevronRight,
  GripVertical,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  WidgetPreview,
  screenConfigs,
  type WidgetBranding,
  type WidgetTheme,
} from "../../branding/preview";
import {
  FIELD_TYPES,
  FIXED_MAP_TARGETS,
  PARTIAL_INSERTION_POINTS,
  PARTIAL_PROMPTS,
  ensureUlpName,
  errorLocation,
  isValidMapTarget,
  moveField,
  nameFromLabel,
  parseFields,
  serializeFields,
  validateFields,
  type BuilderField,
  type FieldIssue,
  type PartialInsertionPoint,
  type PromptPartials,
} from "./partialsBuilder";

type Mode = "fields" | "html";

/** A builder field with a stable id, so React keeps row state when fields move. */
type DraftField = BuilderField & { uid: string };

let nextUid = 0;
const withUid = (field: BuilderField): DraftField => ({
  ...field,
  uid: `f${++nextUid}`,
});
type Html = Partial<Record<PartialInsertionPoint, string>>;

const NONE = "none";
const METADATA = "user_metadata";

const MAP_HELP: Record<string, string> = {
  [NONE]:
    "Not stored on the user. The value is still sent to Actions as event.request.body, where you can validate or store it yourself.",
  given_name: "Saved as the user's given name (first name).",
  family_name: "Saved as the user's family name (last name).",
  name: "Saved as the user's full name.",
  nickname: "Saved as the user's nickname.",
  [METADATA]:
    "Saved as a custom field on the user, under user_metadata with the key you choose.",
};

function mapSelectValue(mapTo?: string): string {
  if (!mapTo) return NONE;
  if (mapTo.startsWith(`${METADATA}.`)) return METADATA;
  return mapTo;
}

type MoveAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "to"; point: PartialInsertionPoint };

/** Keyboard- and touch-friendly alternative to dragging a field. */
type FieldMove = {
  canUp: boolean;
  canDown: boolean;
  targets: { point: PartialInsertionPoint; disabled: boolean }[];
  onMove: (action: MoveAction) => void;
};

type FieldDnd = {
  dragging: boolean;
  hint: "before" | "after" | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (position: "before" | "after") => void;
};

function FieldRow({
  field,
  dnd,
  move,
  issues,
  onChange,
  onRemove,
}: {
  field: DraftField;
  dnd: FieldDnd;
  move: FieldMove;
  /** Issues to show on this field (already filtered by the caller). */
  issues: FieldIssue[];
  onChange: (field: DraftField) => void;
  onRemove: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [editingName, setEditingName] = useState(false);
  const selected = mapSelectValue(field.mapTo);
  const metadataKey = field.mapTo?.startsWith(`${METADATA}.`)
    ? field.mapTo.slice(METADATA.length + 1)
    : "";

  return (
    <div
      ref={rowRef}
      className={cn(
        "relative space-y-3 rounded-md border p-3",
        dnd.dragging && "opacity-40",
        issues.length > 0 && "border-destructive",
      )}
      onDragOver={(e) => {
        // Only react to our own drags, and let the panel see the drop.
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        dnd.onDragOver(
          e.clientY < rect.top + rect.height / 2 ? "before" : "after",
        );
      }}
    >
      {dnd.hint && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 h-1 rounded bg-primary",
            dnd.hint === "before" ? "-top-2.5" : "-bottom-2.5",
          )}
        />
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          draggable
          role="button"
          aria-label="Drag to reorder or move to another section"
          title="Drag to reorder or move to another section"
          className="cursor-grab rounded p-0.5 hover:bg-muted active:cursor-grabbing"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", "partial-field");
            if (rowRef.current)
              e.dataTransfer.setDragImage(rowRef.current, 16, 16);
            dnd.onDragStart();
          }}
          onDragEnd={dnd.onDragEnd}
        >
          <GripVertical className="size-4" />
        </span>
        <span className="truncate">{field.label || "New field"}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Label</Label>
          <Input
            value={field.label}
            onChange={(e) => {
              const label = e.target.value;
              // Keep the name following the label until it is edited by hand.
              const followsLabel =
                !field.name || field.name === nameFromLabel(field.label);
              onChange({
                ...field,
                label,
                name: followsLabel ? nameFromLabel(label) : field.name,
              });
            }}
          />
        </div>
        <div className="space-y-1">
          <Label>Field name</Label>
          {editingName ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={field.name}
                onChange={(e) => onChange({ ...field, name: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingName(false)}
              >
                Done
              </Button>
            </div>
          ) : (
            <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/40 px-3">
              <code className="truncate text-sm">
                {ensureUlpName(field.name)}
              </code>
              <button
                type="button"
                className="shrink-0 text-xs text-primary hover:underline"
                onClick={() => setEditingName(true)}
              >
                Edit
              </button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {editingName
              ? "Letters, numbers, - and _. The ulp- prefix is added for you."
              : "Set from the label. Actions read the value under this name."}
          </p>
        </div>
        <div className="space-y-1">
          <Label>Type</Label>
          <Select
            value={field.type}
            onValueChange={(type) =>
              onChange({ ...field, type: type as BuilderField["type"] })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Save to</Label>
          <Select
            value={selected}
            onValueChange={(v) => {
              if (v === NONE) onChange({ ...field, mapTo: undefined });
              else if (v === METADATA)
                onChange({ ...field, mapTo: `${METADATA}.` });
              else onChange({ ...field, mapTo: v });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Don&apos;t save</SelectItem>
              {FIXED_MAP_TARGETS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
              <SelectItem value={METADATA}>
                user_metadata.&lt;key&gt;
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {MAP_HELP[selected] ?? ""}
          </p>
        </div>
        {selected === METADATA && (
          <div className="space-y-1 sm:col-span-2">
            <Label>user_metadata key</Label>
            <Input
              value={metadataKey}
              placeholder="company"
              onChange={(e) =>
                onChange({ ...field, mapTo: `${METADATA}.${e.target.value}` })
              }
            />
            {field.mapTo && !isValidMapTarget(field.mapTo) && (
              <p className="text-xs text-destructive">
                Use letters, numbers, &quot;-&quot; or &quot;_&quot; for the
                key.
              </p>
            )}
          </div>
        )}
        {field.type === "select" ? (
          <div className="space-y-1 sm:col-span-2">
            <Label>Options (one per line)</Label>
            <Textarea
              rows={3}
              value={(field.options ?? []).join("\n")}
              onChange={(e) =>
                onChange({ ...field, options: e.target.value.split("\n") })
              }
            />
          </div>
        ) : field.type !== "checkbox" ? (
          <>
            <div className="space-y-1">
              <Label>Placeholder</Label>
              <Input
                value={field.placeholder ?? ""}
                onChange={(e) =>
                  onChange({ ...field, placeholder: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Max length</Label>
              <Input
                type="number"
                min={1}
                value={field.maxLength ?? ""}
                onChange={(e) =>
                  onChange({
                    ...field,
                    maxLength: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
              />
            </div>
          </>
        ) : null}
      </div>
      {issues.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" role="alert">
          {issues.map((issue) => (
            <li key={issue.message}>{issue.message}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={field.required}
            onCheckedChange={(v) =>
              onChange({ ...field, required: v === true })
            }
          />
          Required
        </label>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Move field"
              >
                <ArrowUpDown className="mr-1 size-4" />
                Move
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!move.canUp}
                onSelect={() => move.onMove({ type: "up" })}
              >
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!move.canDown}
                onSelect={() => move.onMove({ type: "down" })}
              >
                Move down
              </DropdownMenuItem>
              {move.targets.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Move to section</DropdownMenuLabel>
                  {move.targets.map((t) => (
                    <DropdownMenuItem
                      key={t.point}
                      disabled={t.disabled}
                      onSelect={() =>
                        move.onMove({ type: "to", point: t.point })
                      }
                    >
                      <code className="text-xs">{t.point}</code>
                      {t.disabled && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          HTML mode
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label="Remove field"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

const POINT_DESCRIPTIONS: Record<PartialInsertionPoint, string> = {
  "form-content-start": "Top of the form, before the built-in fields",
  "form-content-end": "After the built-in fields, before the submit button",
  "form-footer-start": "Just below the submit button, above the links",
  "form-footer-end": "Below the links at the bottom (e.g. Sign up)",
  "secondary-actions-start": "Above the social login buttons",
  "secondary-actions-end": "Below the social login buttons",
};

const zonePlaceholder = (point: string) =>
  `<div style="border:1px dashed #9ca3af;border-radius:6px;color:#6b7280;font:12px ui-monospace,monospace;margin:6px 0;padding:6px 8px;text-align:center">${point}</div>`;

const hasContent = (html?: string) => !!html && html.trim().length > 0;

function summarize(html: string): string | null {
  if (!hasContent(html)) return null;
  const fields = parseFields(html);
  if (!fields) return "Custom HTML";
  return `${fields.length} field${fields.length === 1 ? "" : "s"}`;
}

type PanelState = { mode: Mode; fields: DraftField[]; html: string };
type Panels = Record<PartialInsertionPoint, PanelState>;

type PanelDnd = {
  /** Index of the field being dragged out of this panel, if any. */
  dragging: number | null;
  /** Where a drop would land in this panel, if it is the current target. */
  dropIndex: number | null;
  /** A field drag is in progress anywhere. */
  active: boolean;
  start: (index: number) => void;
  end: () => void;
  over: (index: number | null) => void;
  drop: (index: number) => void;
};

function InsertionPointPanel({
  point,
  state,
  error,
  open,
  dnd,
  issues,
  moveTargets,
  onMoveField,
  onToggle,
  onChange,
}: {
  point: PartialInsertionPoint;
  state: PanelState;
  error?: string;
  open: boolean;
  dnd: PanelDnd;
  /** Per-field issues to display, parallel to `state.fields`. */
  issues: FieldIssue[][];
  /** Other sections a field can be moved to, and whether each accepts fields. */
  moveTargets: FieldMove["targets"];
  onMoveField: (index: number, action: MoveAction) => void;
  onToggle: () => void;
  onChange: (state: PanelState) => void;
}) {
  const { mode, fields, html } = state;
  const [parseError, setParseError] = useState(false);

  const updateFields = (next: DraftField[]) =>
    onChange({ ...state, fields: next, html: serializeFields(next) });

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "fields") {
      // Imported HTML only becomes fields if it round-trips unchanged.
      const parsed = parseFields(html);
      if (!parsed) {
        setParseError(true);
        return;
      }
      onChange({ mode: "fields", fields: parsed.map(withUid), html });
    } else {
      onChange({ ...state, mode: "html" });
    }
    setParseError(false);
  };

  const summary = summarize(html);
  const issueCount = issues.reduce((n, i) => n + i.length, 0);
  const canDrop = dnd.active && mode === "fields";

  // The body stays mounted when collapsed so unsaved builder state survives.
  return (
    <div
      className={cn(
        "rounded-lg border transition-shadow",
        dnd.dropIndex !== null && "ring-2 ring-primary/50",
      )}
      onDragOver={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Hovering a collapsed section opens it; the end of the list is the
        // default drop position (fields override this with their own).
        if (!open) onToggle();
        dnd.over(fields.length);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          dnd.over(null);
        }
      }}
      onDrop={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        dnd.drop(dnd.dropIndex ?? fields.length);
      }}
    >
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              "size-4 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="flex flex-col">
            <code className="text-sm font-medium">{point}</code>
            <span className="text-xs text-muted-foreground">
              {POINT_DESCRIPTIONS[point]}
            </span>
          </span>
        </button>
        {issueCount > 0 && (
          <Badge variant="destructive">
            {issueCount} issue{issueCount === 1 ? "" : "s"}
          </Badge>
        )}
        {error && <Badge variant="destructive">Error</Badge>}
        {summary && <Badge variant="secondary">{summary}</Badge>}
      </div>

      <div hidden={!open} className="space-y-3 border-t p-4">
        <div className="flex items-center justify-end">
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={mode}
            onValueChange={(v) => v && switchMode(v as Mode)}
          >
            <ToggleGroupItem value="fields">Fields</ToggleGroupItem>
            <ToggleGroupItem value="html">HTML</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {parseError && (
          <Alert>
            <AlertDescription>
              This HTML can&apos;t be represented as fields without changing it,
              so it stays in HTML mode.
            </AlertDescription>
          </Alert>
        )}

        {mode === "fields" ? (
          <div className="space-y-3">
            {fields.map((field, i) => (
              <FieldRow
                key={field.uid}
                field={field}
                issues={issues[i] ?? []}
                dnd={{
                  dragging: dnd.dragging === i,
                  hint:
                    dnd.dropIndex === i
                      ? "before"
                      : dnd.dropIndex === i + 1 && i === fields.length - 1
                        ? "after"
                        : null,
                  onDragStart: () => dnd.start(i),
                  onDragEnd: dnd.end,
                  onDragOver: (position) =>
                    dnd.over(position === "before" ? i : i + 1),
                }}
                move={{
                  canUp: i > 0,
                  canDown: i < fields.length - 1,
                  targets: moveTargets,
                  onMove: (action) => onMoveField(i, action),
                }}
                onChange={(f) =>
                  updateFields(fields.map((x, j) => (j === i ? f : x)))
                }
                onRemove={() => updateFields(fields.filter((_, j) => j !== i))}
              />
            ))}
            {fields.length === 0 && dnd.active && (
              <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                Drop a field here
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                updateFields([
                  ...fields,
                  withUid({
                    label: "",
                    name: "",
                    type: "text",
                    required: false,
                  }),
                ])
              }
            >
              <Plus className="mr-1 size-4" />
              Add field
            </Button>
          </div>
        ) : (
          <Textarea
            rows={8}
            className="font-mono text-xs"
            value={html}
            onChange={(e) => onChange({ ...state, html: e.target.value })}
            spellCheck={false}
          />
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}

/** HTML that parses cleanly opens in Fields mode, anything else in HTML mode. */
function panelFromHtml(html?: string): PanelState {
  const value = html ?? "";
  const parsed = parseFields(value);
  return parsed
    ? { mode: "fields", fields: parsed.map(withUid), html: value }
    : { mode: "html", fields: [], html: value };
}

const emptyPanels = (): Panels =>
  Object.fromEntries(
    PARTIAL_INSERTION_POINTS.map((p) => [p, panelFromHtml()]),
  ) as Panels;

/** Stable string of the non-empty partials, to detect unsaved changes. */
function serializeDraft(html: Html): string {
  return JSON.stringify(
    PARTIAL_INSERTION_POINTS.filter((p) => hasContent(html[p])).map((p) => [
      p,
      html[p],
    ]),
  );
}

type PreviewData = { branding: WidgetBranding; theme?: WidgetTheme };

export function PartialsTab() {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const [prompt, setPrompt] = useState<string>("signup");
  const [stored, setStored] = useState<PromptPartials>({});
  const [panels, setPanels] = useState<Panels>(emptyPanels);
  const html = useMemo<Html>(
    () =>
      Object.fromEntries(
        PARTIAL_INSERTION_POINTS.map((p) => [p, panels[p].html]),
      ),
    [panels],
  );
  const [drag, setDrag] = useState<{
    point: PartialInsertionPoint;
    index: number;
  } | null>(null);
  const [dropAt, setDropAt] = useState<{
    point: PartialInsertionPoint;
    index: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<
    Partial<Record<PartialInsertionPoint, string>>
  >({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [open, setOpen] = useState<
    Partial<Record<PartialInsertionPoint, boolean>>
  >({});
  const [baseline, setBaseline] = useState("[]");
  const [attempted, setAttempted] = useState(false);
  const savedHtml = useRef<Html>({});
  // Only the latest load may apply its result; switching prompts quickly must
  // not let an older response overwrite the newer selection.
  const loadSeq = useRef(0);

  const issues = useMemo(() => {
    const lists: Partial<Record<PartialInsertionPoint, DraftField[]>> = {};
    for (const point of PARTIAL_INSERTION_POINTS) {
      if (panels[point].mode === "fields") lists[point] = panels[point].fields;
    }
    return validateFields(lists);
  }, [panels]);
  const totalIssues = Object.values(issues).reduce(
    (n, perField) => n + (perField ?? []).reduce((m, i) => m + i.length, 0),
    0,
  );
  // Unfinished-field issues stay hidden until the user tries to save.
  const visibleIssues = (point: PartialInsertionPoint): FieldIssue[][] =>
    (issues[point] ?? []).map((list) =>
      list.filter((i) => attempted || i.when === "always"),
    );
  const dirty = serializeDraft(html) !== baseline;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    setErrors({});
    setGeneralError(null);
    try {
      const { data } = await dataProvider.getOne("partials", {
        id: prompt,
      });
      if (seq !== loadSeq.current) return;
      const all = (data.partials ?? {}) as PromptPartials;
      setStored(all);
      const loaded = all[prompt] ?? {};
      savedHtml.current = loaded;
      setPanels(
        Object.fromEntries(
          PARTIAL_INSERTION_POINTS.map((p) => [p, panelFromHtml(loaded[p])]),
        ) as Panels,
      );
      setBaseline(serializeDraft(loaded));
      setAttempted(false);
      // Open the sections that have content; the rest start collapsed.
      setOpen(
        Object.fromEntries(
          PARTIAL_INSERTION_POINTS.map((p) => [p, hasContent(loaded[p])]),
        ),
      );
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // Stay in the error state until a retry succeeds. The editor holds no
      // loaded data, so saving would overwrite the stored partials.
      setLoadError((err as Error).message || "Unknown error");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [dataProvider, prompt]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    dataProvider
      .getOne("branding", { id: "branding" })
      .then(({ data }) => {
        if (cancelled) return;
        const bg = data.colors?.page_background;
        setPreview({
          branding: {
            colors: {
              primary: data.colors?.primary,
              page_background:
                typeof bg === "string" ? { type: "solid", start: bg } : bg,
            },
            logo_url: data.logo_url,
            favicon_url: data.favicon_url,
            font: data.font,
          },
          theme: data.themes
            ? {
                borders: data.themes.borders,
                colors: data.themes.colors,
                fonts: data.themes.fonts,
                page_background: data.themes.page_background,
                widget: data.themes.widget,
              }
            : undefined,
        });
      })
      .catch(() => {
        if (!cancelled) setPreview({ branding: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider]);

  const changePrompt = (next: string) => {
    if (
      next !== prompt &&
      dirty &&
      !window.confirm("You have unsaved changes. Discard them and switch?")
    ) {
      return;
    }
    setPrompt(next);
  };

  /** Throws away unsaved edits and goes back to what was last saved. */
  const discard = () => {
    setPanels(
      Object.fromEntries(
        PARTIAL_INSERTION_POINTS.map((p) => [
          p,
          panelFromHtml(savedHtml.current[p]),
        ]),
      ) as Panels,
    );
    setErrors({});
    setAttempted(false);
  };

  const addFirstField = () => {
    setPanels((prev) => {
      const target = prev["form-content-end"];
      const fields = [
        ...(target.mode === "fields" ? target.fields : []),
        withUid({ label: "", name: "", type: "text", required: false }),
      ];
      return {
        ...prev,
        "form-content-end": {
          mode: "fields",
          fields,
          html: serializeFields(fields),
        },
      };
    });
    setOpen((o) => ({ ...o, "form-content-end": true }));
  };

  const isEmpty = PARTIAL_INSERTION_POINTS.every((p) => !hasContent(html[p]));

  const save = async () => {
    if (loadError) return;
    if (totalIssues > 0) {
      setAttempted(true);
      // Open the sections that have something to fix.
      setOpen((o) => ({
        ...o,
        ...Object.fromEntries(
          PARTIAL_INSERTION_POINTS.filter((p) =>
            (issues[p] ?? []).some((list) => list.length > 0),
          ).map((p) => [p, true]),
        ),
      }));
      return;
    }
    setSaving(true);
    setErrors({});
    setGeneralError(null);
    const nonEmpty = Object.fromEntries(
      Object.entries(html).filter(([, v]) => hasContent(v)),
    );
    const partials: PromptPartials = { ...stored };
    if (Object.keys(nonEmpty).length) partials[prompt] = nonEmpty;
    else delete partials[prompt];
    try {
      const { data } = await dataProvider.update("partials", {
        id: prompt,
        data: { partials },
        previousData: {},
      });
      setStored(data.partials ?? {});
      savedHtml.current = html;
      setBaseline(serializeDraft(html));
      setAttempted(false);
      notify("Partials saved", { type: "success" });
    } catch (err) {
      const e = err as { body?: { message?: string }; message?: string };
      const message = e.body?.message ?? e.message ?? "Failed to save";
      const point = errorLocation(message);
      if (point) {
        setErrors({ [point]: message });
        setOpen((o) => ({ ...o, [point]: true }));
      } else setGeneralError(message);
    } finally {
      setSaving(false);
    }
  };

  const endDrag = () => {
    setDrag(null);
    setDropAt(null);
  };

  /** Moves a field to `toIndex` of `to`, within or across sections. */
  const applyMove = (
    from: { point: PartialInsertionPoint; index: number },
    to: PartialInsertionPoint,
    toIndex: number,
  ) => {
    setPanels((prev) => {
      if (prev[from.point].mode !== "fields" || prev[to].mode !== "fields") {
        return prev;
      }
      const moved = moveField(
        { [from.point]: prev[from.point].fields, [to]: prev[to].fields },
        from,
        { point: to, index: toIndex },
      );
      if (!moved) return prev;
      const next = { ...prev };
      for (const [point, fields] of Object.entries(moved) as [
        PartialInsertionPoint,
        DraftField[],
      ][]) {
        next[point] = {
          ...prev[point],
          fields,
          html: serializeFields(fields),
        };
      }
      return next;
    });
    setOpen((o) => ({ ...o, [to]: true }));
  };

  const dropField = (to: PartialInsertionPoint, toIndex: number) => {
    if (drag) applyMove(drag, to, toIndex);
    endDrag();
  };

  /** The menu equivalent of dragging: up/down in place, or to the end of another section. */
  const moveFieldBy = (
    point: PartialInsertionPoint,
    index: number,
    action: MoveAction,
  ) => {
    const from = { point, index };
    if (action.type === "up") applyMove(from, point, index - 1);
    else if (action.type === "down") applyMove(from, point, index + 2);
    else applyMove(from, action.point, panels[action.point].fields.length);
  };

  const previewScreen = useMemo(() => {
    const base = prompt.startsWith("signup")
      ? screenConfigs.signup
      : prompt === "login-password"
        ? screenConfigs.password
        : screenConfigs.login;
    // Empty zones get a labelled placeholder so the preview shows where each
    // insertion point sits. Preview only: never saved.
    const partials = Object.fromEntries(
      PARTIAL_INSERTION_POINTS.map((point) => [
        point,
        html[point]?.trim() ? html[point] : zonePlaceholder(point),
      ]),
    );
    return { ...base, partials };
  }, [prompt, html]);

  return (
    <div
      className="flex flex-col gap-4"
      // This tab sits inside the Settings <form>: stop Enter in a text input
      // from submitting it.
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          (e.target as HTMLElement).tagName === "INPUT"
        ) {
          e.preventDefault();
        }
      }}
    >
      <p className="max-w-2xl text-sm text-muted-foreground">
        Add your own fields and content to the sign-up and login screens. A
        common use is collecting extra details such as first and last name, a
        company name or a terms checkbox.
      </p>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          <div className="z-10 -mx-1 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 sm:sticky sm:top-0 border-b bg-background px-1 py-3">
            <div className="w-44 space-y-1">
              <Label>Prompt</Label>
              <Select value={prompt} onValueChange={changePrompt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PARTIAL_PROMPTS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
              {dirty && (
                <>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    Unsaved changes
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={discard}
                  >
                    <Undo2 className="mr-1 size-4" />
                    Discard
                  </Button>
                </>
              )}
              <Button
                type="button"
                onClick={save}
                disabled={saving || loading || !!loadError || !dirty}
              >
                {saving ? "Saving…" : "Save partials"}
              </Button>
            </div>
          </div>

          {attempted && totalIssues > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                Fix {totalIssues} issue{totalIssues === 1 ? "" : "s"} marked
                below before saving.
              </AlertDescription>
            </Alert>
          )}

          {generalError && (
            <Alert variant="destructive">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          )}

          {!loading && loadError && (
            <Alert variant="destructive">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>Failed to load partials: {loadError}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={load}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {!loading && !loadError && isEmpty && (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-5">
              <div>
                <p className="text-sm font-medium">No fields yet</p>
                <p className="text-sm text-muted-foreground">
                  Start with a field below the built-in fields on this screen,
                  such as a first name. You can move it to another position
                  later by dragging it.
                </p>
              </div>
              <Button type="button" size="sm" onClick={addFirstField}>
                <Plus className="mr-1 size-4" />
                Add your first field
              </Button>
            </div>
          )}

          {!loading &&
            !loadError &&
            PARTIAL_INSERTION_POINTS.map((point) => (
              <InsertionPointPanel
                key={`${prompt}:${point}`}
                point={point}
                state={panels[point]}
                error={errors[point]}
                open={!!open[point]}
                issues={visibleIssues(point)}
                moveTargets={PARTIAL_INSERTION_POINTS.filter(
                  (p) => p !== point,
                ).map((p) => ({
                  point: p,
                  disabled: panels[p].mode !== "fields",
                }))}
                onMoveField={(index, action) =>
                  moveFieldBy(point, index, action)
                }
                dnd={{
                  dragging: drag?.point === point ? drag.index : null,
                  dropIndex: dropAt?.point === point ? dropAt.index : null,
                  active: !!drag,
                  start: (index) => setDrag({ point, index }),
                  end: endDrag,
                  over: (index) =>
                    setDropAt((cur) =>
                      index === null
                        ? cur?.point === point
                          ? null
                          : cur
                        : cur?.point === point && cur.index === index
                          ? cur
                          : { point, index },
                    ),
                  drop: (index) => dropField(point, index),
                }}
                onToggle={() => setOpen((o) => ({ ...o, [point]: !o[point] }))}
                onChange={(next) => setPanels((p) => ({ ...p, [point]: next }))}
              />
            ))}
        </div>

        <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
          {preview && (
            <WidgetPreview
              screen={previewScreen}
              branding={preview.branding}
              theme={preview.theme}
              className="min-h-[480px] p-4"
            />
          )}
        </div>
      </div>
    </div>
  );
}
