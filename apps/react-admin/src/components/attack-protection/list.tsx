import { useEffect } from "react";
import { useRedirect, useBasename } from "react-admin";

export function AttackProtectionList() {
  const redirect = useRedirect();
  const basename = useBasename();

  useEffect(() => {
    redirect(`${basename}/attack-protection/attack-protection`);
  }, [redirect, basename]);

  return null;
}
