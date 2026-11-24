import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { ColorInput } from "./color-input";

type MockProps = {
  source: string;
  parse?: (v: string) => unknown;
  validate?:
    | ((v: string) => string | undefined)
    | ((v: string) => string | undefined)[];
};
type ChangeLike = string | { target: { value: string } };

vi.mock("ra-core", async () => {
  const { useController } = await import("react-hook-form");
  return {
    FieldTitle: ({ label }: { label: string }) => <>{label}</>,
    useInput: (props: MockProps) => {
      const c = useController({
        name: props.source,
        rules: {
          validate: (v: string) => {
            const vs = Array.isArray(props.validate)
              ? props.validate
              : [props.validate];
            for (const f of vs) {
              const r = f?.(v);
              if (r) return r;
            }
            return true;
          },
        },
      });
      const onChange = (e: ChangeLike) => {
        const raw = typeof e === "string" ? e : e.target.value;
        c.field.onChange(props.parse ? props.parse(raw) : raw);
      };
      return {
        id: props.source,
        field: { ...c.field, onChange },
        isRequired: false,
      };
    },
  };
});
vi.mock("@/components/admin/form", () => ({
  FormField: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  FormLabel: ({ children }: { children: React.ReactNode }) => (
    <label>{children}</label>
  ),
  FormControl: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  FormError: () => null,
}));
vi.mock("@/components/admin/input-helper-text", () => ({
  InputHelperText: () => null,
}));

let form: ReturnType<typeof useForm>;
function Harness({ value }: { value?: string }) {
  form = useForm<Record<string, unknown>>({ defaultValues: { c: value } });
  return (
    <FormProvider {...form}>
      <ColorInput
        source="c"
        label="Colour"
        clearable
        emptyPlaceholder="Derived"
      />
    </FormProvider>
  );
}
afterEach(cleanup);

describe("ColorInput", () => {
  it("shows a validation message for a non-hex, invalid value", () => {
    render(<Harness value="#7D68F4" />);
    fireEvent.change(screen.getByPlaceholderText("Derived"), {
      target: { value: "purple-ish" },
    });
    expect(screen.getByRole("alert").textContent).toMatch(/valid colour/);
  });

  it("accepts rgb() without a message", () => {
    render(<Harness value="#7D68F4" />);
    fireEvent.change(screen.getByPlaceholderText("Derived"), {
      target: { value: "rgb(1, 2, 3)" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clearing stores an empty string, not null", () => {
    render(<Harness value="#7D68F4" />);
    fireEvent.click(screen.getByLabelText("Reset Colour"));
    expect(form.getValues("c")).toBe("");
  });
});
