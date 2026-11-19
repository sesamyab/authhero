import { useEffect, useRef, useState } from "react";
import { useController, useFormContext, useWatch } from "react-hook-form";
import { useNotify } from "ra-core";
import { ImageIcon, Loader2, Type, Upload, X } from "lucide-react";
import { TextInput } from "@/components/admin";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

// Mirrors the server rules in authhero/src/helpers/branding-assets.ts.
const HINT: Record<BrandingAssetKind, string> = {
  logo: "PNG, JPEG, WebP, GIF or SVG · max 2 MB",
  powered_by_logo: "PNG, JPEG, WebP, GIF or SVG · max 2 MB",
  favicon: "PNG, JPEG, WebP, GIF, SVG or ICO · max 512 KB",
  background: "PNG, JPEG, WebP or SVG · max 5 MB",
  font: "WOFF2, WOFF, TTF or OTF · max 2 MB",
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
  const { setValue, getValues, watch, control } = useFormContext();
  const value = useWatch({ name: source }) as string | undefined;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [previewBroken, setPreviewBroken] = useState(false);
  const uploadingRef = useRef(false);
  // True when the field was edited by the user while an upload was in flight.
  const editedDuringUpload = useRef(false);
  const valueAtStart = useRef<unknown>(undefined);

  // Block form submission while an upload is pending: a hidden, value-less
  // field whose validator fails until the upload settles. useController
  // re-registers it on render, so it survives a form reset.
  useController({
    control,
    name: `__upload_pending.${source.replace(/\./g, "_")}`,
    rules: {
      validate: () =>
        !uploadingRef.current || "Wait for the upload to finish before saving",
    },
  });

  // Track edits synchronously (the subscription fires inside setValue/onChange,
  // before any later upload completion can run).
  useEffect(() => {
    const sub = watch((_, { name }) => {
      if (!uploadingRef.current) return;
      // An ancestor update (e.g. the Themes JSON editor replacing `themes`)
      // reports the parent name, so also compare the field's value.
      if (name === source || getValues(source) !== valueAtStart.current) {
        editedDuringUpload.current = true;
      }
    });
    return () => sub.unsubscribe();
  }, [watch, getValues, source]);

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
    valueAtStart.current = getValues(source);
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

  // A new URL gets a fresh chance to load.
  useEffect(() => setPreviewBroken(false), [value]);

  const PlaceholderIcon = kind === "font" ? Type : ImageIcon;

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT[kind]}
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-muted-foreground hover:text-foreground"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          {uploading ? "Uploading…" : "Upload"}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <div
          className="flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-[conic-gradient(#e5e5e5_25%,#fff_0_50%,#e5e5e5_0_75%,#fff_0)] bg-[length:10px_10px] text-muted-foreground"
          aria-hidden
        >
          {value && kind !== "font" && !previewBroken ? (
            <img
              src={value}
              alt=""
              className="h-full w-full object-contain"
              onError={() => setPreviewBroken(true)}
            />
          ) : (
            <PlaceholderIcon className="size-4" />
          )}
        </div>
        <div className="relative min-w-0 flex-1">
          <TextInput
            source={source}
            label={false}
            parse={parse}
            inputClassName="pr-9"
            aria-label={label}
          />
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-1/2 right-1.5 size-6 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground"
              disabled={uploading}
              aria-label="Clear"
              onClick={() => setValue(source, "", { shouldDirty: true })}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{HINT[kind]}</p>
    </div>
  );
}
