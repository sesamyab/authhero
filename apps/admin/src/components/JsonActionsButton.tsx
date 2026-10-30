import { useListContext, useNotify, type RaRecord } from "ra-core";
import { Braces, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Copies or downloads the rows of the surrounding list as JSON, e.g. to paste
 * into an LLM chat. It works on what the table holds: the selected rows when
 * any are selected, otherwise the current page with its filters and sort.
 */
export function JsonActionsButton({
  className,
  size = "sm",
}: {
  className?: string;
  size?: "default" | "sm";
}) {
  const { data, selectedIds, resource, isPending } = useListContext();

  const selected = new Set(selectedIds);
  const rows: RaRecord[] =
    selected.size > 0
      ? (data ?? []).filter((record) => selected.has(record.id))
      : (data ?? []);
  const scope = selected.size > 0 ? "selected" : "on this page";

  return (
    <JsonActionsMenu
      data={rows}
      filename={`${resource}-${new Date().toISOString().replace(/[:.]/g, "-")}`}
      label={`${rows.length} ${rows.length === 1 ? "row" : "rows"} ${scope}`}
      className={className}
      size={size}
      disabled={isPending || rows.length === 0}
    />
  );
}

/**
 * A "JSON" dropdown that copies `data` to the clipboard or downloads it as
 * `<filename>.json`, pretty-printed.
 */
export function JsonActionsMenu({
  data,
  filename,
  label,
  className,
  size = "sm",
  disabled,
}: {
  data: unknown;
  filename: string;
  label?: string;
  className?: string;
  size?: "default" | "sm";
  disabled?: boolean;
}) {
  const notify = useNotify();

  const toJson = () => JSON.stringify(data, null, 2);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(toJson())
      .then(() => notify("Copied JSON to clipboard", { type: "info" }))
      .catch(() => notify("Could not copy to clipboard", { type: "error" }));
  };

  const handleDownload = () => {
    const blob = new Blob([toJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={size}
          className={className}
          disabled={disabled}
        >
          <Braces />
          JSON
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {label && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {label}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={handleCopy}>
          <Copy />
          Copy JSON
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleDownload}>
          <Download />
          Download JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
