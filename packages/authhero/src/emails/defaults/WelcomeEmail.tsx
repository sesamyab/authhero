/** @jsxImportSource react */
import { Heading, Section, Text } from "@react-email/components";
import { Layout } from "./Layout";
import { PrimaryButton } from "./PrimaryButton";

export function WelcomeEmail() {
  return (
    <Layout preview={"{{ welcome_to_your_account }}"}>
      <Heading className="text-xl font-semibold mb-2">
        {"{{ welcome_to_your_account }}"}
      </Heading>
      <Text>{"{{ welcome_body }}"}</Text>
      {`{% if url %}`}
      <Section className="text-center my-4">
        <PrimaryButton href={"{{ url }}"}>
          {"{{ welcome_cta }}"}
        </PrimaryButton>
      </Section>
      {`{% endif %}`}
    </Layout>
  );
}
