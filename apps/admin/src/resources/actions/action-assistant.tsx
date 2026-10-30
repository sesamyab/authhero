import { useEffect, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { useTenantId } from "@/TenantContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  actionRequest,
  getActionGeneration,
  type ActionGenerationModel as Model,
  type ActionVerification,
} from "./api";

const modelNames: Record<Model, string> = {
  glm: "GLM",
  deepseek: "DeepSeek",
  qwen: "Qwen",
};

export function ActionAssistant() {
  const tenantId = useTenantId() ?? "";
  const { getValues, setValue } = useFormContext();
  const code = useWatch({ name: "code" }) as string | undefined;
  const triggerId =
    (useWatch({ name: "trigger_id" }) as string | undefined) || "post-login";
  const inherit = useWatch({ name: "inherit" });
  const supportedTriggers = useWatch({ name: "supported_triggers" }) as
    | Array<{ id: string }>
    | undefined;
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState<Model>("glm");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{
    code: string;
    triggerId: string;
    tenantId: string;
  }>();
  const [verification, setVerification] = useState<{
    source: string;
    tenantId: string;
    result: ActionVerification;
  }>();
  const source = JSON.stringify({
    code,
    supported_triggers:
      supportedTriggers?.[0]?.id === triggerId
        ? supportedTriggers
        : [{ id: triggerId }],
  });

  useEffect(() => {
    let cancelled = false;
    setModels([]);
    setDraft(undefined);
    setVerification(undefined);
    getActionGeneration(tenantId).then((result) => {
      if (cancelled) return;
      setModels(result.models);
      if (result.models[0]) setModel(result.models[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (inherit) return null;

  const generate = async () => {
    setBusy(true);
    setError("");
    setDraft(undefined);
    try {
      const result = await actionRequest<{ code: string }>(
        tenantId,
        "generate",
        { prompt, model, trigger_id: triggerId },
      );
      setDraft({ code: result.code, triggerId, tenantId });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await actionRequest<ActionVerification>(
        tenantId,
        "verify",
        JSON.parse(source),
      );
      setVerification({ source, tenantId, result });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  };
  const currentResult =
    verification?.source === source && verification.tenantId === tenantId
      ? verification.result
      : undefined;
  const currentDraft =
    draft?.triggerId === triggerId && draft.tenantId === tenantId
      ? draft
      : undefined;

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-md border p-4">
      {models.length > 0 && (
        <>
          <Label htmlFor="action-generation-model">Generate with AI</Label>
          <Select
            value={model}
            onValueChange={(value) => setModel(value as Model)}
            disabled={busy}
          >
            <SelectTrigger id="action-generation-model" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((id) => (
                <SelectItem key={id} value={id}>
                  {modelNames[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="action-generation-prompt">Describe your action</Label>
          <Textarea
            id="action-generation-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={10_000}
            disabled={busy}
            placeholder="For example, deny login when the user's email is unverified."
          />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={busy || !prompt.trim()}
            onClick={generate}
          >
            {busy ? "Working…" : "Generate draft"}
          </Button>
          {currentDraft && (
            <>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">
                {currentDraft.code}
              </pre>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    if (getValues("inherit")) return;
                    setValue("code", currentDraft.code, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                    setVerification(undefined);
                    setDraft(undefined);
                  }}
                >
                  Use generated code
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDraft(undefined)}
                >
                  Discard draft
                </Button>
              </div>
            </>
          )}
        </>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={busy || !code?.trim()}
          onClick={verify}
        >
          Verify code
        </Button>
        {currentResult?.valid && (
          <span role="status" className="text-sm">
            Verification passed
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Checks JavaScript syntax, the trigger handler, and direct Action API
        calls. Verification runs again before saving. Use the Test tab after
        saving to check behavior with sample events.
      </p>
      {currentResult && !currentResult.valid && (
        <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
          {currentResult.errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
