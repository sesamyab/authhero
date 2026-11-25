import { useState } from "react";
import { useRecordContext } from "ra-core";
import { List, DataTable } from "@/components/admin";
import { CreateButton } from "@/components/admin/create-button";
import { ExportButton } from "@/components/admin/export-button";
import { JsonActionsButton } from "@/components/JsonActionsButton";
import { Badge } from "@/components/ui/badge";
import { InviteDeveloperButton } from "./developer-access/invite-dialog";
import { AppInvitesCard } from "./developer-access/app-invites";
import { isInvitedClient } from "./developer-access/developer-access-tab";

function InvitedBadge() {
  const record = useRecordContext();
  return isInvitedClient(record) ? (
    <Badge variant="secondary">Invited</Badge>
  ) : null;
}

export function ClientList() {
  // Bumped when an invite is created so the invites card reloads.
  const [invitesKey, setInvitesKey] = useState(0);

  return (
    <>
      <List
        actions={
          <div className="flex items-center gap-2">
            <InviteDeveloperButton
              onInvited={() => setInvitesKey((key) => key + 1)}
            />
            <CreateButton />
            <ExportButton />
            <JsonActionsButton size="default" />
          </div>
        }
      >
        <DataTable rowClick="edit">
          <DataTable.Col source="id" />
          <DataTable.Col source="name" />
          <DataTable.Col label="">
            <InvitedBadge />
          </DataTable.Col>
          <DataTable.Col source="created_at" />
          <DataTable.Col source="updated_at" />
        </DataTable>
      </List>
      <AppInvitesCard refreshKey={invitesKey} />
    </>
  );
}
