import { List, DataTable } from "@/components/admin";
import { InheritedBadge } from "@/components/inheritance/InheritedBadge";
import { useShowInheritance } from "@/hooks/useHasChildren";

export function ConnectionsList() {
  const showInheritance = useShowInheritance();
  return (
    <List>
      <DataTable rowClick="edit">
        <DataTable.Col source="id" />
        <DataTable.Col source="name" />
        <DataTable.Col source="strategy" />
        {showInheritance && (
          <DataTable.Col label="Source">
            <InheritedBadge />
          </DataTable.Col>
        )}
        <DataTable.Col source="created_at" />
        <DataTable.Col source="updated_at" />
      </DataTable>
    </List>
  );
}
