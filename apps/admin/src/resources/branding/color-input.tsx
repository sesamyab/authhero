import { useInput, FieldTitle, type InputProps } from "ra-core";
import { X } from "lucide-react";
import {
  FormControl,
  FormError,
  FormField,
  FormLabel,
} from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputHelperText } from "@/components/admin/input-helper-text";
import { isHexColor, validateColor } from "./theme-colors";

type ColorInputProps = InputProps & {
  helperText?: React.ReactNode;
  /**
   * Shown while the field is empty. Used for optional overrides (dark scheme),
   * where empty means "same as light / derived".
   */
  emptyPlaceholder?: string;
  /** Show a button that clears the value back to empty. */
  clearable?: boolean;
  /** Swatch to show while empty (e.g. the light value the field falls back to). */
  fallbackSwatch?: string;
};

// An empty input is "" rather than ra-core's default null, so clearing a
// value is sent as a clear instead of being dropped from the PATCH.
const keepEmptyString = (v: string | null | undefined) => v ?? "";

export function ColorInput(props: ColorInputProps) {
  const {
    label,
    source,
    helperText,
    emptyPlaceholder,
    clearable,
    fallbackSwatch,
  } = props;
  const validate = props.validate
    ? Array.isArray(props.validate)
      ? [...props.validate, validateColor]
      : [props.validate, validateColor]
    : validateColor;
  const { id, field, isRequired } = useInput({
    ...props,
    validate,
    parse: keepEmptyString,
  });

  const stringValue = typeof field.value === "string" ? field.value : "";
  const swatchValue = isHexColor(stringValue)
    ? stringValue.slice(0, 7)
    : fallbackSwatch && !stringValue && isHexColor(fallbackSwatch)
      ? fallbackSwatch.slice(0, 7)
      : "#000000";
  const isEmpty = stringValue === "";
  const showNone =
    !isHexColor(stringValue) &&
    !(isEmpty && fallbackSwatch && isHexColor(fallbackSwatch));
  const invalid = validateColor(stringValue) !== undefined;

  return (
    <FormField id={id} name={field.name}>
      {label !== false && (
        <FormLabel>
          <FieldTitle label={label} source={source} isRequired={isRequired} />
        </FormLabel>
      )}
      <FormControl>
        <div className="flex items-center gap-2">
          <div
            className={`relative h-9 w-10 shrink-0 overflow-hidden rounded-md border focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 ${
              showNone
                ? "border-dashed border-muted-foreground bg-[conic-gradient(#e5e5e5_25%,#fff_0_50%,#e5e5e5_0_75%,#fff_0)] bg-[length:8px_8px]"
                : "border-input"
            }`}
            data-empty={showNone || undefined}
          >
            <input
              type="color"
              value={swatchValue}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              className={`absolute -inset-1 size-[calc(100%+0.5rem)] cursor-pointer border-0 bg-transparent p-0 ${
                showNone
                  ? "opacity-0"
                  : isEmpty && emptyPlaceholder
                    ? "opacity-50"
                    : ""
              }`}
              aria-label={typeof label === "string" ? label : source}
            />
          </div>
          <Input
            type="text"
            value={stringValue}
            onChange={(e) => field.onChange(e.target.value)}
            onBlur={field.onBlur}
            placeholder={emptyPlaceholder ?? "#000000"}
            aria-invalid={invalid || undefined}
            className="flex-1 font-mono"
          />
          {clearable && !isEmpty && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => field.onChange("")}
              aria-label={`Reset ${typeof label === "string" ? label : source}`}
              title="Reset"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </FormControl>
      <InputHelperText helperText={helperText} />
      {invalid ? (
        <p role="alert" className="text-sm text-destructive">
          {validateColor(stringValue)}
        </p>
      ) : (
        <FormError />
      )}
    </FormField>
  );
}
