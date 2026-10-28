import {
  type ActionCodeGenerator,
  type ActionGenerationModel,
  TRIGGER_API_SHAPES,
  TRIGGER_FUNCTION_NAMES,
} from "@authhero/adapter-interfaces";

export interface CloudflareActionCodeGeneratorConfig {
  accountId: string;
  gatewayId: string;
  apiToken: string;
  /** Override model IDs without changing core or the admin UI. */
  models?: Partial<Record<ActionGenerationModel, string>>;
  timeoutMs?: number;
  /** Optional transport for platform integrations and local HTTP simulations. */
  fetch?: typeof globalThis.fetch;
}

/** Cloudflare AI Gateway REST API; no provider SDK required. */
export class CloudflareActionCodeGenerator implements ActionCodeGenerator {
  readonly models = ["glm", "deepseek", "qwen"] as const;

  constructor(private readonly config: CloudflareActionCodeGeneratorConfig) {}

  async generate(
    params: Parameters<ActionCodeGenerator["generate"]>[0],
  ): Promise<{ code: string }> {
    const triggerId =
      params.triggerId === "post-login" ? "post-user-login" : params.triggerId;
    const handler = Object.hasOwn(TRIGGER_FUNCTION_NAMES, triggerId)
      ? TRIGGER_FUNCTION_NAMES[triggerId]
      : undefined;
    if (!handler) throw new Error("Unsupported action trigger");
    const modelIds: Record<ActionGenerationModel, string> = {
      glm: "@cf/zai-org/glm-4.7-flash",
      deepseek: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      qwen: "@cf/qwen/qwen3.8-27b",
      ...this.config.models,
    };
    const response = await (this.config.fetch ?? globalThis.fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.config.accountId)}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "content-type": "application/json",
          "cf-aig-gateway-id": this.config.gatewayId,
          // Prompts and generated source should not be stored in gateway logs.
          "cf-aig-collect-log": "false",
          "cf-aig-skip-cache": "true",
        },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 60_000),
        body: JSON.stringify({
          model: modelIds[params.model],
          max_tokens: 8192,
          stream: false,
          messages: [
            {
              role: "system",
              content: [
                "Generate an AuthHero Action as plain JavaScript source only. No Markdown, prose, or reasoning.",
                `Define exports.${handler} = async (event, api) => { ... }; at the top level.`,
                `The only available api namespaces and methods are: ${JSON.stringify(TRIGGER_API_SHAPES[triggerId])}. Do not invent APIs.`,
                "Use the following TypeScript API declarations as reference for parameter types, optional arguments, and return values. The handler's api parameter has type ActionAPI. Output JavaScript only; do not copy type declarations or type annotations into the action.",
                params.apiTypes,
                "This runs in a Web Worker. Use fetch and Web Crypto; no require, imports, npm modules, process, filesystem, or Node APIs.",
                "Read credentials and configurable endpoint URLs from event.secrets. Never embed credentials. Comment with the secret names needed.",
                "Treat event data as untrusted. Validate tokens before using their claims. Handle fetch failures and use bounded timeouts.",
                triggerId === "custom-token-exchange"
                  ? "Validate event.transaction.subject_token before calling exactly one api.authentication.setUserById or setUserByConnection, or reject with api.access.rejectInvalidSubjectToken."
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
            { role: "user", content: params.prompt },
          ],
        }),
      },
    );
    // Do not expose upstream bodies: they can echo credentials or prompt text.
    if (!response.ok)
      throw new Error(`AI Gateway request failed (${response.status})`);
    const body = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: unknown };
      }>;
    };
    const choice = body.choices?.[0];
    if (
      choice?.finish_reason !== "stop" ||
      typeof choice.message?.content !== "string"
    ) {
      throw new Error("AI Gateway did not return a complete action");
    }
    const code = choice.message.content
      .trim()
      .replace(/^```(?:javascript|js)?\s*\n([\s\S]*?)\n```$/, "$1")
      .trim();
    if (!code || code.length > 100_000)
      throw new Error("AI Gateway returned invalid action source");
    return { code };
  }
}
