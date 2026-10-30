import { JsonActionsMenu } from "@/components/JsonActionsButton";

export function JsonOutput({
  data,
  filename = "data",
}: {
  data: unknown;
  /** Name of the downloaded file, without the `.json` extension. */
  filename?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <JsonActionsMenu data={data} filename={filename} />
      </div>
      <pre className="bg-muted text-foreground border rounded-md p-3 text-sm font-mono overflow-auto m-0">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
