import { useState } from "react";
import { required, useGetList } from "ra-core";
import { useWatch } from "react-hook-form";
import { SelectInput } from "@/components/admin";
import { Button } from "@/components/ui/button";
import {
  actionSupportsTrigger,
  type ActionRecord,
} from "../action-triggers/bindings";

/** Select compatible Actions by name, retaining older hook-code references. */
export function ActionInput() {
  const triggerId = useWatch({ name: "trigger_id" }) as string | undefined;
  const selected = useWatch({ name: "code_id" }) as string | undefined;
  const [perPage, setPerPage] = useState(200);
  const { data, total, isPending, error } = useGetList<ActionRecord>(
    "actions",
    {
      pagination: { page: 1, perPage },
      sort: { field: "name", order: "ASC" },
    },
  );
  const choices = (data ?? [])
    .filter((action) => actionSupportsTrigger(action, triggerId))
    .map((action) => ({ id: action.id, name: action.name }));
  if (selected && !choices.some((choice) => choice.id === selected)) {
    choices.push({
      id: selected,
      name:
        data?.find((action) => action.id === selected)?.name ??
        `Action ${selected} (current)`,
    });
  }
  return (
    <>
      <SelectInput
        source="code_id"
        label="Action"
        choices={choices}
        isPending={isPending}
        validate={required()}
        helperText={
          error
            ? "Unable to load the Actions library."
            : "Choose an Action that supports this trigger."
        }
      />
      {(total ?? 0) > (data?.length ?? 0) && (
        <Button
          type="button"
          variant="outline"
          onClick={() => setPerPage((count) => count + 200)}
        >
          Load more actions
        </Button>
      )}
    </>
  );
}
