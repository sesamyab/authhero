import { List, DataTable } from "@/components/admin";
import { InheritedBadge } from "@/components/inheritance/InheritedBadge";

export function ConnectionsList() {
  return (
    <List>
      <DataTable rowClick="edit">
        <DataTable.Col source="id" />
        <DataTable.Col source="name" />
        <DataTable.Col source="strategy" />
        <DataTable.Col label="Source">
          <InheritedBadge />
        </DataTable.Col>
        <DataTable.Col source="created_at" />
        <DataTable.Col source="updated_at" />
      </DataTable>
    </List>
  );
}
