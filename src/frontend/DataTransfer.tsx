import { useRef, useState } from "react";
import { Button, Checkbox, InlineView } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Download } from "lucide-react";
import { useHostMetricsApi } from "./host-metrics-api";

/** Export and import of the user's layouts, checks, templates and history. */
export function DataTransfer({ onClose }: { onClose: () => void }) {
  const api = useHostMetricsApi();
  const { t } = useTranslation();
  const text = (key: string, values?: Record<string, string | number>) =>
    t(`hostMetrics.transfer.${key}`, values);
  const fileInput = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await action();
    } catch {
      setError(text("failed"));
    } finally {
      setBusy(false);
    }
  };

  const download = () =>
    run(async () => {
      const data = await api.exportData(history);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `host-metrics-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });

  const upload = (file: File) =>
    run(async () => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(await file.text());
      } catch {
        setError(text("invalidFile"));
        return;
      }
      if (data?.plugin !== "host-metrics") {
        setError(text("invalidFile"));
        return;
      }
      const result = await api.importData(data, { overwrite, history: true });
      setMessage(
        text("result", {
          imported: result.imported,
          updated: result.updated,
          skipped: result.skipped,
          failed: result.failed,
        }),
      );
    });

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={text("title")}
      icon={<Download className="size-4" />}
    >
      {error && (
        <div role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      <section className="flex flex-col gap-2 border-b border-border pb-3">
        <h3 className="text-sm font-medium">{text("exportTitle")}</h3>
        <p className="text-xs text-muted-foreground">{text("exportHint")}</p>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={history}
            onCheckedChange={(value) => setHistory(value === true)}
          />
          {text("includeHistory")}
        </label>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={busy}
          onClick={download}
        >
          {text("export")}
        </Button>
      </section>
      <section className="flex flex-col gap-2 pt-3">
        <h3 className="text-sm font-medium">{text("importTitle")}</h3>
        <p className="text-xs text-muted-foreground">{text("importHint")}</p>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={overwrite}
            onCheckedChange={(value) => setOverwrite(value === true)}
          />
          {text("overwrite")}
        </label>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          data-testid="metrics-import-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {text("choose")}
        </Button>
      </section>
    </InlineView>
  );
}
