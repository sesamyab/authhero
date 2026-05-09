/** @jsxImportSource react */
import { Heading, Text } from "@react-email/components";
import { Layout } from "./Layout";

export function VerifyEmailByCode() {
  return (
    <Layout preview={"{{ welcome_to_your_account }}"}>
      <Heading className="text-xl font-semibold mb-2">
        {"{{ welcome_to_your_account }}"}
      </Heading>
      <Text>{"{{ link_email_click_to_login }}"}</Text>
      <Text className="text-3xl font-bold text-center my-4 tracking-[0.25em]">
        {"{{ code }}"}
      </Text>
      <Text className="text-xs text-zinc-500 text-center">
        {"{{ code_valid_30_minutes }}"}
      </Text>
    </Layout>
  );
}
