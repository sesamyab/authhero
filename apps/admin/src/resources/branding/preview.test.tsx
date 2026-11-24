// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";

const fetchPreviewHtml = vi.fn();
vi.mock("./previewClient", async () => {
  const actual =
    await vi.importActual<typeof import("./previewClient")>("./previewClient");
  return {
    ...actual,
    getApiUrl: () => "http://api.test",
    fetchPreviewHtml: (...args: unknown[]) => fetchPreviewHtml(...args),
    openFullPreview: vi.fn(),
  };
});
vi.mock("ra-core", () => ({ useNotify: () => vi.fn() }));
vi.mock("@/TenantContext", () => ({ useTenantId: () => "t1" }));

import {
  BrandingPreview,
  WidgetPreview,
  buildPreviewBranding,
  screenConfigs,
} from "./preview";

function Form({ children }: { children: React.ReactNode }) {
  const methods = useForm({
    defaultValues: { themes: { colors_dark: { primary_button: "#112233" } } },
  });
  return <FormProvider {...methods}>{children}</FormProvider>;
}

describe("BrandingPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchPreviewHtml.mockReset();
    fetchPreviewHtml.mockResolvedValue(
      "<html><head></head><body>x</body></html>",
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
  }

  it("renders in light, then asks the server for dark when toggled", async () => {
    const { getByRole } = render(
      <Form>
        <BrandingPreview />
      </Form>,
    );
    await flush();
    expect(fetchPreviewHtml).toHaveBeenLastCalledWith(
      expect.objectContaining({ screen: "login", colorScheme: "light" }),
    );

    fireEvent.click(getByRole("button", { name: /dark/i }));
    await flush();
    const call = fetchPreviewHtml.mock.lastCall![0];
    expect(call.colorScheme).toBe("dark");
    // The explicit dark fields reach the server untouched.
    expect(call.theme.colors_dark.primary_button).toBe("#112233");
  });

  it("offers OTP, MFA, consent and error next to the existing screens", async () => {
    const { getByRole } = render(
      <Form>
        <BrandingPreview />
      </Form>,
    );
    for (const [label, screen] of [
      ["OTP", "otp"],
      ["MFA", "mfa"],
      ["Consent", "consent"],
      ["Error", "error"],
      ["Signup", "signup"],
      ["Password", "password"],
    ] as const) {
      fireEvent.click(getByRole("button", { name: label }));
      await flush();
      expect(fetchPreviewHtml).toHaveBeenLastCalledWith(
        expect.objectContaining({ screen }),
      );
    }
  });

  it("can be driven from outside through colorScheme / onColorSchemeChange", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <Form>
        <BrandingPreview colorScheme="dark" onColorSchemeChange={onChange} />
      </Form>,
    );
    await flush();
    expect(fetchPreviewHtml).toHaveBeenLastCalledWith(
      expect.objectContaining({ colorScheme: "dark" }),
    );
    fireEvent.click(getByRole("button", { name: /light/i }));
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("renders the server HTML in a sandboxed iframe without same-origin", async () => {
    const { container } = render(
      <Form>
        <BrandingPreview />
      </Form>,
    );
    await flush();
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toContain(
      '<base href="http://api.test/">',
    );
  });
});

describe("WidgetPreview with hostile values", () => {
  afterEach(cleanup);

  it("passes values as properties and never as markup", () => {
    const hostile = `'></authhero-widget><img src=x onerror="window.__pwned=1"><authhero-widget x='`;
    const screen = {
      ...screenConfigs.login,
      title: hostile,
      description: hostile,
    };
    const branding = buildPreviewBranding({
      logoUrl: hostile,
      colors: { primary: hostile },
    });
    const { container } = render(
      <WidgetPreview screen={screen} branding={branding} theme={{}} />,
    );

    // Exactly one widget, no injected elements.
    expect(container.querySelectorAll("authhero-widget")).toHaveLength(1);
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    const widget = container.querySelector("authhero-widget") as unknown as {
      screen: { title: string };
      branding: { logo_url: string };
    };
    expect(widget.screen.title).toBe(hostile);
    expect(widget.branding.logo_url).toBe(hostile);
    expect(
      container.querySelector("authhero-widget")!.getAttributeNames(),
    ).toEqual([]);
  });
});
