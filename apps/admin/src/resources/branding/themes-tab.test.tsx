import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm, useFormContext } from "react-hook-form";
import { ThemesTab } from "./themes-tab";

vi.mock("./color-input", () => ({
  ColorInput: ({ source }: { source: string }) => {
    const { register } = useFormContext();
    return <input data-testid={source} {...register(source)} />;
  },
}));
vi.mock("./asset-url-input", () => ({
  AssetUrlInput: ({ source }: { source: string }) => {
    const { register } = useFormContext();
    return <input data-testid={source} {...register(source)} />;
  },
}));
vi.mock("./themes-raw", () => ({ ThemesRawEditor: () => null }));
vi.mock("@/components/admin", () => {
  const Stub = ({ source }: { source: string }) => (
    <input data-testid={source} />
  );
  return {
    TextInput: Stub,
    NumberInput: Stub,
    BooleanInput: Stub,
    SelectInput: Stub,
  };
});

const light = {
  primary_button: "#7D68F4",
  widget_background: "#FFFFFF",
  body_text: "#000000",
  links_focused_components: "#7D68F4",
  widget_border: "#8E8CA0",
  error: "#FC5A5A",
  base_focus_color: "#7D68F4",
  primary_button_label: "#FFFFFF",
  header: "#000000",
  input_background: "#FFFFFF",
  input_border: "#8E8CA0",
  input_filled_text: "#000000",
  secondary_button_border: "#8E8CA0",
  secondary_button_label: "#000000",
  base_hover_color: "#123456",
};

let form: ReturnType<typeof useForm>;
function Harness() {
  form = useForm<Record<string, unknown>>({
    defaultValues: { themes: { colors: { ...light } } },
  });
  return (
    <FormProvider {...form}>
      <ThemesTab />
    </FormProvider>
  );
}
afterEach(cleanup);

describe("ThemesTab", () => {
  it("shows the core colours and keeps the rest under Advanced", () => {
    render(<Harness />);
    expect(screen.getByTestId("themes.colors.primary_button")).toBeTruthy();
    const advanced = document.getElementById("theme-advanced")!;
    expect(advanced.className).toContain("hidden");
    expect(
      screen
        .getByText("Advanced")
        .closest("button")!
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("derived colours follow the core, but a customised one is left alone", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("themes.colors.primary_button"), {
      target: { value: "#112233" },
    });
    expect(form.getValues("themes.colors.base_focus_color")).toBe("#112233");
    // hover was customised (not equal to the old derived value)
    expect(form.getValues("themes.colors.base_hover_color")).toBe("#123456");
  });

  it("dark view edits colors_dark, and generate fills it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Dark"));
    expect(
      screen.getByTestId("themes.colors_dark.primary_button"),
    ).toBeTruthy();
    expect(screen.getByTestId("themes.widget.logo_url_dark")).toBeTruthy();
    fireEvent.click(screen.getByText("Generate dark from light"));
    expect(form.getValues("themes.colors_dark.widget_background")).toBe(
      "#1F2937",
    );
    expect(form.getValues("themes.colors_dark.primary_button")).toBe("#7D68F4");
    expect(form.getValues("themes.page_background.background_color_dark")).toBe(
      "#111827",
    );
  });
});
