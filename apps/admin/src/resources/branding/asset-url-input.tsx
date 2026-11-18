import { useEffect, useRef, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useNotify } from "ra-core";
import { Loader2, Upload, X } from "lucide-react";
import { TextInput } from "@/components/admin";
import { Button } from "@/components/ui/button";
import { useTenantId } from "@/TenantContext";
import { getApiUrl, getHttpClient } from "./previewClient";

// Latest upload per field, shared across remounts so a superseded upload
// (e.g. started before the tab unmounted) never writes its URL.
const latestUpload = new Map<string, symbol>();

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
  const { setValue, register, unregister, watch } = useFormContext();
  const value = useWatch({ name: source }) as string | undefined;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  // True when the field was edited by the user while an upload was in flight.
  const editedDuringUpload = useRef(false);

  // Block form submission while an upload is pending: a hidden, value-less
  // field whose validator fails until the upload settles.
  const guardName = `__upload_pending.${source.replace(/\./g, "_")}`;
  useEffect(() => {
    register(guardName, {
      validate: () =>
        !uploadingRef.current || "Wait for the upload to finish before saving",
    });
    return () => unregister(guardName);
  }, [register, unregister, guardName]);

  // Track edits synchronously (the subscription fires inside setValue/onChange,
  // before any later upload completion can run).
  useEffect(() => {
    const sub = watch((_, { name }) => {
      if (name === source && uploadingRef.current) {
        editedDuringUpload.current = true;
      }
    });
    return () => sub.unsubscribe();
  }, [watch, source]);

  // Leaving the tab discards an in-flight upload: its result is ignored and the
  // admin is told, so it can't overwrite an edit made after returning.
  useEffect(
    () => () => {
      if (uploadingRef.current) latestUpload.delete(source);
    },
    [source],
  );

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES[kind]) {
      notify(`File is too large (max ${MAX_BYTES[kind] / 1024} KB)`, {
        type: "error",
      });
      return;
    }
    setUploading(true);
    uploadingRef.current = true;
    editedDuringUpload.current = false;
    const token = Symbol("upload");
    latestUpload.set(source, token);
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
      if (latestUpload.get(source) !== token) {
        notify("Upload was discarded because the form changed", {
          type: "warning",
        });
        return;
      }
      if (editedDuringUpload.current) return;
      setValue(source, url, { shouldDirty: true, shouldTouch: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      notify(msg, { type: "error" });
    } finally {
      uploadingRef.current = false;
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
