import { describe, expect, it } from "vitest";
import {
  customEmailProviderMessageTypeSchema,
  customPhoneProviderMessageTypeSchema,
} from "@authhero/adapter-interfaces";
import {
  describeMessageTypes,
  getMessageTypeChoices,
  isNotificationTrigger,
} from "./notification-message-types";

describe("custom provider message types", () => {
  it("offers exactly Auth0's message types for each trigger", () => {
    expect(
      getMessageTypeChoices("custom-email-provider")
        .map((c) => c.id)
        .sort(),
    ).toEqual([...customEmailProviderMessageTypeSchema.options].sort());
    expect(
      getMessageTypeChoices("custom-phone-provider")
        .map((c) => c.id)
        .sort(),
    ).toEqual([...customPhoneProviderMessageTypeSchema.options].sort());
    expect(getMessageTypeChoices("post-user-login")).toEqual([]);
  });

  it("describes a binding's selection", () => {
    expect(describeMessageTypes("custom-email-provider", undefined)).toBe(
      "All message types",
    );
    expect(
      describeMessageTypes("custom-email-provider", { message_types: [] }),
    ).toBe("All message types");
    expect(
      describeMessageTypes("custom-phone-provider", {
        message_types: ["otp_enroll", "unknown_type"],
      }),
    ).toBe("MFA enrollment codes, unknown_type");
  });

  it("recognises only the custom provider triggers", () => {
    expect(isNotificationTrigger("custom-email-provider")).toBe(true);
    expect(isNotificationTrigger("custom-phone-provider")).toBe(true);
    expect(isNotificationTrigger("pre-screen")).toBe(false);
  });
});
