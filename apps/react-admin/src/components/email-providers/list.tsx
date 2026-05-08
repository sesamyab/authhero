import { useEffect } from "react";
import { useRedirect, useBasename } from "react-admin";

export function EmailProvidersList() {
  const redirect = useRedirect();
  const basename = useBasename();

  useEffect(() => {
    // Singleton resource: redirect to edit with the resource name as the ID.
    redirect(`${basename}/email-providers/email-providers`);
  }, [redirect, basename]);

  return null;
}
