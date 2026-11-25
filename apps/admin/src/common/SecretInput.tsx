import { useState } from "react";
import { useWatch } from "react-hook-form";
import { useSourceContext } from "ra-core";
import { TextInput, type TextInputProps } from "@/components/admin";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Eye, EyeOff } from "lucide-react";

export type SecretInputProps = TextInputProps & {
  /**
   * Source of the masked preview of the stored secret. Defaults to
   * `<source>_hint`, which is what the management API returns.
   */
  hintSource?: string;
};

/** True when a value starts or ends with a space, tab or line break. */
export function hasEdgeWhitespace(value: unknown): boolean {
  return typeof value === "string" && value !== value.trim();
}

/**
 * Password-style input for a write-only secret.
 *
 * The API never returns the stored secret, so the field starts empty. When it
 * returns a masked hint (e.g. `3a9f••••••••`) we show it as the placeholder,
 * so you can tell a secret is set — and which one — without revealing it.
 * Submitting the form with the field left blank keeps the stored value.
 *
 * The masked input hides whitespace, so a secret pasted with a stray
 * leading or trailing space looks fine. We warn when the value starts or
 * ends with whitespace.
 */
export function SecretInput({ hintSource, ...props }: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  // Resolve the source against any enclosing scope (e.g. an ArrayInput row),
  // the same way the TextInput itself does.
  const sourceContext = useSourceContext();
  const name = sourceContext.getSource(props.source);
  const hint = useWatch({
    name: hintSource ? sourceContext.getSource(hintSource) : `${name}_hint`,
  });
  const value = useWatch({ name });
  const hasHint = typeof hint === "string" && hint.length > 0;

  return (
    <div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextInput
            {...props}
            type={visible ? "text" : "password"}
            placeholder={hasHint ? hint : props.placeholder}
            helperText={
              props.helperText ??
              (hasHint ? "Leave blank to keep the current value" : undefined)
            }
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide secret" : "Show secret"}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </Button>
      </div>
      {hasEdgeWhitespace(value) && (
        <p
          role="status"
          className="mt-1 flex items-center gap-1 text-sm text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          This value starts or ends with whitespace. Check that it was pasted
          correctly.
        </p>
      )}
    </div>
  );
}
