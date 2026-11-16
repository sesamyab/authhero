import { Link } from "react-router-dom";
import { Building2, Plus, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DEFAULT_APP_NAME, getAppName } from "@/utils/runtimeConfig";

/**
 * What a user with no tenants sees instead of an empty table: what a tenant
 * is, and either the way to create one or who can give them access.
 */
export function TenantsEmptyState({ canCreate }: { canCreate: boolean }) {
  const appName = getAppName();
  // "AuthHero Admin" names the tool; welcome people to the product instead.
  // A deployment that sets its own name is welcomed under that name.
  const productName = appName === DEFAULT_APP_NAME ? "AuthHero" : appName;
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-lg text-center">
        <CardHeader className="items-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            {canCreate ? (
              <Rocket className="h-6 w-6" aria-hidden />
            ) : (
              <Building2 className="h-6 w-6" aria-hidden />
            )}
          </div>
          <CardTitle>
            {canCreate ? `Welcome to ${productName}` : "No tenants yet"}
          </CardTitle>
          <CardDescription>
            A tenant is your own auth server for your users and apps.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          {canCreate ? (
            <Button asChild>
              <Link to="/tenants/create">
                <Plus className="h-4 w-4 mr-1" />
                Create your first tenant
              </Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              You don&apos;t have access to any tenant. Ask an admin of your
              organization to create one or invite you to theirs.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
