import { describe, expect, it } from "vitest";
import { hookInsertSchema } from "@authhero/adapter-interfaces";
import { getTriggerChoicesForType } from "./hookConstants";

describe("hook trigger choices", () => {
  it("offers webhooks exactly the triggers the management API accepts for them", () => {
    const accepted = getTriggerChoicesForType("url")
      .map((c) => c.id)
      .filter(
        (trigger_id) =>
          hookInsertSchema.safeParse({ url: "https://example.com", trigger_id })
            .success,
      );
    expect(getTriggerChoicesForType("url").map((c) => c.id)).toEqual(accepted);
    expect(getTriggerChoicesForType("url").map((c) => c.id)).not.toContain(
      "pre-screen",
    );
    expect(getTriggerChoicesForType("code").map((c) => c.id)).toContain(
      "pre-screen",
    );
  });
});
