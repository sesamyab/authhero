import { useRecordContext } from "ra-core";
import { useWatch } from "react-hook-form";
import { BooleanInput, SelectInput } from "@/components/admin";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isSyncedRowId, rowIdOf } from "@/lib/syncedRows";

export const SCOPE_CHOICES = [
  { id: "local", name: "Local - only this tenant" },
  { id: "shared", name: "Shared - child tenants inherit it" },
  { id: "platform", name: "Platform - child tenants run it, never see it" },
];

export const OVERRIDE_CHOICES = [
  { id: "none", name: "Nothing - children cannot change it" },
  { id: "secrets", name: "Secrets only" },
  { id: "fields", name: "Fields - children may change it" },
];

/**
 * Publishing properties of a row (config inheritance): whether child tenants
 * receive it, and what they may change. Not shown for rows that are
 * themselves copies from a parent - the server forbids changing them there.
 */
export function PublishingFields() {
  const record = useRecordContext<{ id?: string; hook_id?: string }>();
  const scope = useWatch({ name: "scope" }) as string | undefined;
  if (isSyncedRowId(rowIdOf(record))) return null;

  const published = scope === "shared" || scope === "platform";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Publishing</CardTitle>
        <CardDescription>
          Control whether tenants below this one receive this row. Takes effect
          the next time their config is synced.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SelectInput
          source="scope"
          label="Scope"
          choices={SCOPE_CHOICES}
          emptyText="Not set (local)"
          helperText="Unset behaves as local for new rows."
        />
        {published && (
          <>
            <SelectInput
              source="override"
              label="Override"
              choices={OVERRIDE_CHOICES}
              emptyText="Not set (fields)"
              helperText="What a child tenant may change on its copy."
            />
            <BooleanInput
              source="enforce"
              label="Enforce"
              helperText="Child tenants cannot disable or delete it."
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
