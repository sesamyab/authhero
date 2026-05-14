/** @jsxImportSource react */
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import { ReactNode } from "react";

interface LayoutProps {
  preview?: string;
  children: ReactNode;
}

/**
 * Shared frame for all built-in email defaults. Liquid placeholders
 * (`{{ branding.logo }}`, `{{ tenant.support_url }}`, etc.) are emitted as
 * raw strings; the runtime Liquid pass interpolates them per-send.
 */
export function Layout({ preview, children }: LayoutProps) {
  return (
    <Html lang="en">
      <Head />
      {preview ? <Preview>{preview}</Preview> : null}
      <Tailwind>
        <Body className="bg-zinc-100 font-sans">
          <Container className="bg-white max-w-[560px] my-8 mx-auto rounded-md overflow-hidden">
            <Section className="px-6 pt-6 pb-2 text-center">
              {`{% if branding.logo %}`}
              <Img
                src={"{{ branding.logo }}"}
                alt={"{{ tenant.friendly_name }}"}
                width={120}
                className="mx-auto"
              />
              {`{% endif %}`}
            </Section>
            <Section className="px-6 pb-6 text-zinc-800">{children}</Section>
            <Hr className="border-zinc-200 m-0" />
            <Section className="px-6 py-4 text-center">
              <Text className="text-xs text-zinc-500 m-0">
                {"{{ support_info }}"} {`{% if tenant.support_url %}`}
                <Link
                  href={"{{ tenant.support_url }}"}
                  className="text-zinc-500 underline"
                >
                  {"{{ contact_us }}"}
                </Link>
                {`{% endif %}`}
              </Text>
              <Text className="text-xs text-zinc-500 mt-2 mb-0">
                {"{{ copyright }}"}
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
