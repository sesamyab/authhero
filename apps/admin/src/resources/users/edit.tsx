import { useState } from "react";
import { useDelete, useNotify, useRecordContext, useRedirect } from "ra-core";
import { Trash } from "lucide-react";
import { Edit, SimpleForm } from "@/components/admin";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UrlTabs } from "@/components/ui/url-tabs";
import { DetailsTab } from "./tabs/details-tab";
import { SessionsTab } from "./tabs/sessions-tab";
import { RefreshTokensTab } from "./tabs/refresh-tokens-tab";
import { GrantsTab } from "./tabs/grants-tab";
import { LogsTab } from "./tabs/logs-tab";
import { PermissionsTab } from "./tabs/permissions-tab";
import { RolesTab } from "./tabs/roles-tab";
import { OrganizationsTab } from "./tabs/organizations-tab";
import { MfaTab } from "./tabs/mfa-tab";
import type { UserIdentity } from "./tabs/types";
import { RawJsonTab } from "@/common/RawJsonTab";

interface UserHeaderRecord {
  identities?: UserIdentity[];
  user_id?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  blocked?: boolean;
}

function UserEditTitle() {
  const record = useRecordContext<UserHeaderRecord>();
  if (!record) return null;
  const heading = record.name || record.email || record.user_id || "";
  return (
    <span className="flex min-w-0 max-w-full items-center gap-4">
      <Avatar className="size-14 shrink-0 text-xl">
        <AvatarImage src={record.picture} alt="" />
        <AvatarFallback className="bg-brand font-bold text-brand-foreground">
          {heading.charAt(0).toUpperCase() || "?"}
        </AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-col gap-1.5">
        {/* overflow-wrap: anywhere lets a long name or ID wrap, so the title
            never forces horizontal scroll on a narrow screen. */}
        <span className="[overflow-wrap:anywhere]">{heading}</span>
        <span className="flex flex-wrap items-center gap-2 text-sm font-normal tracking-normal text-muted-foreground">
          {record.email && record.email !== heading && (
            <span>{record.email}</span>
          )}
          {record.email_verified && (
            <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              Verified
            </Badge>
          )}
          {record.blocked && <Badge variant="destructive">Blocked</Badge>}
          {record.user_id && (
            <code className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-foreground/80 [overflow-wrap:anywhere]">
              {record.user_id}
            </code>
          )}
        </span>
      </span>
    </span>
  );
}

function DeleteUserButton() {
  const record = useRecordContext<UserHeaderRecord & { id: string }>();
  const [deleteOne, { isPending }] = useDelete();
  const notify = useNotify();
  const redirect = useRedirect();
  const [open, setOpen] = useState(false);

  if (!record) return null;
  const linkedCount = Math.max((record.identities?.length ?? 1) - 1, 0);

  const handleDelete = () =>
    deleteOne(
      "users",
      { id: record.id, previousData: record },
      {
        onSuccess: () => {
          notify("User deleted", { type: "success" });
          setOpen(false);
          redirect("list", "users");
        },
        onError: () => notify("Error deleting user", { type: "error" }),
      },
    );

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="cursor-pointer hover:bg-destructive/10! text-destructive! border-destructive!"
        onClick={() => setOpen(true)}
      >
        <Trash />
        Delete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user</DialogTitle>
            <DialogDescription>
              Delete {record.user_id ?? record.id}? This cannot be undone.
              {linkedCount > 0 &&
                ` The ${linkedCount} linked identit${
                  linkedCount === 1 ? "y" : "ies"
                } will be deleted with it.`}{" "}
              Any app that stores this user&apos;s ID will no longer find them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={handleDelete}
            >
              Delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function UserEdit() {
  return (
    <Edit
      mutationMode="pessimistic"
      title={<UserEditTitle />}
      actions={
        <div className="flex justify-end items-center gap-2">
          <DeleteUserButton />
        </div>
      }
    >
      <SimpleForm className="max-w-none">
        <UrlTabs defaultValue="details" className="w-full">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="refresh-tokens">Refresh Tokens</TabsTrigger>
            <TabsTrigger value="grants">Grants</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="organizations">Organizations</TabsTrigger>
            <TabsTrigger value="mfa">MFA</TabsTrigger>
            <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="mt-4">
            <DetailsTab />
          </TabsContent>
          <TabsContent value="sessions" className="mt-4">
            <SessionsTab />
          </TabsContent>
          <TabsContent value="refresh-tokens" className="mt-4">
            <RefreshTokensTab />
          </TabsContent>
          <TabsContent value="grants" className="mt-4">
            <GrantsTab />
          </TabsContent>
          <TabsContent value="logs" className="mt-4">
            <LogsTab />
          </TabsContent>
          <TabsContent value="permissions" className="mt-4">
            <PermissionsTab />
          </TabsContent>
          <TabsContent value="roles" className="mt-4">
            <RolesTab />
          </TabsContent>
          <TabsContent value="organizations" className="mt-4">
            <OrganizationsTab />
          </TabsContent>
          <TabsContent value="mfa" className="mt-4">
            <MfaTab />
          </TabsContent>
          <TabsContent value="raw" className="mt-4">
            <RawJsonTab />
          </TabsContent>
        </UrlTabs>
      </SimpleForm>
    </Edit>
  );
}
