import { List, DataTable } from "@/components/admin";
import { InheritedBadge } from "@/components/inheritance/InheritedBadge";
import { useShowInheritance } from "@/hooks/useHasChildren";
import { useRecordContext } from "ra-core";

function HookType() {
  const record = useRecordContext<{
    url?: string;
    form_id?: string;
    template_id?: string;
    code_id?: string;
    page_id?: string;
  }>();
  if (!record) return null;
  if (record.url) return <>Webhook</>;
  if (record.form_id) return <>Form</>;
  if (record.template_id) return <>Template</>;
  if (record.code_id) return <>Code</>;
  if (record.page_id) return <>Page</>;
  return <>—</>;
}

export function HookList() {
  const showInheritance = useShowInheritance();
  return (
    <List>
      <DataTable rowClick="edit">
        <DataTable.Col source="hook_id" />
        <DataTable.Col label="Type">
          <HookType />
        </DataTable.Col>
        <DataTable.Col source="trigger_id" />
        <DataTable.Col source="enabled" />
        <DataTable.Col source="synchronous" />
        <DataTable.Col source="priority" />
        {showInheritance && (
          <DataTable.Col label="Source">
            <InheritedBadge />
          </DataTable.Col>
        )}
      </DataTable>
    </List>
  );
}
