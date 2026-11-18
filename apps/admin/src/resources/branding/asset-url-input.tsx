import { useRef, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useNotify } from "ra-core";
import { Loader2, Upload, X } from "lucide-react";
import { TextInput } from "@/components/admin";
import { Button } from "@/components/ui/button";
import { useTenantId } from "@/TenantContext";
import { getApiUrl, getHttpClient } from "./previewClient";

export type BrandingAssetKind =
  | "logo"
  | "favicon"
  | "powered_by_logo"
  | "background"
  | "font";

const ACCEPT: Record<BrandingAssetKind, string> = {
  logo: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml",
  powered_by_logo: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml",
  favicon:
    "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico",
  background: "image/png,image/jpeg,image/webp,image/svg+xml",
  font: "font/woff2,font/woff,font/ttf,font/otf,.woff2,.woff,.ttf,.otf",
};

const MAX_BYTES: Record<BrandingAssetKind, number> = {
  logo: 2 * 1024 * 1024,
  powered_by_logo: 2 * 1024 * 1024,
  favicon: 512 * 1024,
  background: 5 * 1024 * 1024,
  font: 2 * 1024 * 1024,
};

/**
 * A URL text input with an upload button. Uploading stores the file via the
 * branding uploads API and writes the returned URL into the field, so the
 * branding schema is unchanged and external URLs keep working.
 */
export function AssetUrlInput({
  source,
  label,
  kind,
  parse,
}: {
  source: string;
  label: string;
  kind: BrandingAssetKind;
  parse?: (v: string | null | undefined) => string;
}) {
  const notify = useNotify();
  const tenantId = useTenantId() ?? "";
  const { setValue, getValues } = useFormContext();
  const value = useWatch({ name: source }) as string | undefined;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES[kind]) {
      notify(`File is too large (max ${MAX_BYTES[kind] / 1024} KB)`, {
        type: "error",
      });
      return;
    }
    setUploading(true);
    const before = getValues(source);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await getHttpClient(tenantId)(
        `${getApiUrl()}/api/v2/branding/uploads/${kind}`,
        {
          method: "POST",
          headers: new Headers({ "tenant-id": tenantId }),
          body: form,
        },
      );
      const url = (res as { json?: { url?: string } }).json?.url;
      if (!url) throw new Error("No URL returned");
      // Don't clobber an edit made while the upload was in flight.
      if (getValues(source) !== before) return;
      setValue(source, url, { shouldDirty: true, shouldTouch: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      notify(msg, { type: "error" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <TextInput source={source} label={label} parse={parse} />
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT[kind]}
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" />
          )}
          Upload
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setValue(source, "", { shouldDirty: true })}
          >
            <X className="size-4" />
            Clear
          </Button>
        )}
        {value && kind !== "font" && (
          <img
            src={value}
            alt=""
            className="h-8 max-w-24 rounded border object-contain"
          />
        )}
      </div>
    </div>
  );
}
