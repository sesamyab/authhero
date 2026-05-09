/** @jsxImportSource react */
import { Heading, Section, Text } from "@react-email/components";
import { Layout } from "./Layout";
import { PrimaryButton } from "./PrimaryButton";

export function ResetEmail() {
  return (
    <Layout preview={"{{ password_reset_title }}"}>
      <Heading className="text-xl font-semibold mb-2">
        {"{{ password_reset_title }}"}
      </Heading>
      <Text>{"{{ reset_password_email_click_to_reset }}"}</Text>
      <Section className="text-center my-4">
        <PrimaryButton href={"{{ url }}"}>
          {"{{ reset_password_email_reset }}"}
        </PrimaryButton>
      </Section>
    </Layout>
  );
}
