/** @jsxImportSource react */
import { Heading, Section, Text } from "@react-email/components";
import { Layout } from "./Layout";
import { PrimaryButton } from "./PrimaryButton";

export function VerifyEmail() {
  return (
    <Layout preview={"{{ welcome_to_your_account }}"}>
      <Heading className="text-xl font-semibold mb-2">
        {"{{ welcome_to_your_account }}"}
      </Heading>
      <Text>{"{{ link_email_click_to_login }}"}</Text>
      <Section className="text-center my-4">
        <PrimaryButton href={"{{ url }}"}>
          {"{{ link_email_login }}"}
        </PrimaryButton>
      </Section>
      {`{% if code %}`}
      <Text className="text-center text-zinc-500 mt-4">
        {"{{ link_email_or_enter_code }}"}
      </Text>
      <Text className="text-3xl font-bold text-center my-2 tracking-[0.25em]">
        {"{{ code }}"}
      </Text>
      <Text className="text-xs text-zinc-500 text-center">
        {"{{ code_valid_30_minutes }}"}
      </Text>
      {`{% endif %}`}
    </Layout>
  );
}
