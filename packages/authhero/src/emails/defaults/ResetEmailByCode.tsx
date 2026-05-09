/** @jsxImportSource react */
import { Heading, Text } from "@react-email/components";
import { Layout } from "./Layout";

export function ResetEmailByCode() {
  return (
    <Layout preview={"{{ password_reset_title }}"}>
      <Heading className="text-xl font-semibold mb-2">
        {"{{ password_reset_title }}"}
      </Heading>
      <Text>{"{{ reset_password_email_click_to_reset }}"}</Text>
      <Text className="text-3xl font-bold text-center my-4 tracking-[0.25em]">
        {"{{ code }}"}
      </Text>
      <Text className="text-xs text-zinc-500 text-center">
        {"{{ code_valid_30_minutes }}"}
      </Text>
    </Layout>
  );
}
