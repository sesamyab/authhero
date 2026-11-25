import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { SourceContextProvider, useSourceContext } from "ra-core";
import type { ReactNode } from "react";
import { SecretInput, hasEdgeWhitespace } from "./SecretInput";

vi.mock("@/components/admin", async () => {
  const { useFormContext } = await import("react-hook-form");
  return {
    TextInput: ({
      source,
      placeholder,
    }: {
      source: string;
      placeholder?: string;
    }) => {
      const { register } = useFormContext();
      const name = useSourceContext().getSource(source);
      return (
        <input
          data-testid="secret"
          placeholder={placeholder}
          {...register(name)}
        />
      );
    },
  };
});

function Harness({
  children,
  defaultValues = {},
}: {
  children: ReactNode;
  defaultValues?: Record<string, unknown>;
}) {
  const form = useForm<Record<string, unknown>>({ defaultValues });
  return <FormProvider {...form}>{children}</FormProvider>;
}

const warning = () => screen.queryByText(/starts or ends with whitespace/);

afterEach(cleanup);

describe("hasEdgeWhitespace", () => {
  it("flags leading and trailing whitespace only", () => {
    expect(hasEdgeWhitespace("abc\n")).toBe(true);
    expect(hasEdgeWhitespace(" abc")).toBe(true);
    expect(hasEdgeWhitespace("\tabc")).toBe(true);
    expect(hasEdgeWhitespace("a b c")).toBe(false);
    expect(hasEdgeWhitespace("abc")).toBe(false);
    expect(hasEdgeWhitespace("")).toBe(false);
    expect(hasEdgeWhitespace(undefined)).toBe(false);
  });
});

describe("SecretInput", () => {
  it("warns while the value has leading or trailing whitespace", () => {
    render(
      <Harness>
        <SecretInput source="client_secret" />
      </Harness>,
    );
    const input = screen.getByTestId("secret");
    expect(warning()).toBeNull();

    fireEvent.change(input, { target: { value: "s3cret " } });
    expect(warning()).not.toBeNull();

    fireEvent.change(input, { target: { value: "s3cret" } });
    expect(warning()).toBeNull();
  });

  it("resolves the value and hint inside a scoped source, like an array row", () => {
    render(
      <Harness
        defaultValues={{
          secrets: [{ name: "API_KEY", value: " key", value_hint: "ke••" }],
        }}
      >
        <SourceContextProvider
          value={{
            getSource: (source) => `secrets.0.${source}`,
            getLabel: (source) => source,
          }}
        >
          <SecretInput source="value" />
        </SourceContextProvider>
      </Harness>,
    );
    expect(warning()).not.toBeNull();
    expect(screen.getByTestId("secret").getAttribute("placeholder")).toBe(
      "ke••",
    );
  });
});
