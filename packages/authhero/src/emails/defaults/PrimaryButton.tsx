/** @jsxImportSource react */
import { Button } from "@react-email/components";
import { ReactNode } from "react";

interface PrimaryButtonProps {
  href: string;
  children: ReactNode;
}

/**
 * Liquid-friendly button. The background color is a Liquid placeholder so the
 * runtime pass can substitute the tenant's `branding.primary_color`.
 */
export function PrimaryButton({ href, children }: PrimaryButtonProps) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: "{{ branding.primary_color }}",
        color: "#ffffff",
        borderRadius: "4px",
        fontSize: "14px",
        fontWeight: 600,
        padding: "12px 24px",
        textDecoration: "none",
      }}
    >
      {children}
    </Button>
  );
}
