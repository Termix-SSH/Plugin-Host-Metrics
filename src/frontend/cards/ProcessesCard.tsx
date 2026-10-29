import { useCardSettings } from "../card-settings";
import { useMemo, useState } from "react";
import { MetricCard, PanelSearch } from "@termix-ssh/plugin-sdk/ui";
import { type ServerMetrics } from "../../shared/metrics.js";
import { Cpu } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { type ProcSort, viewProcesses } from "../process-view";

export function ProcessesCard({ metrics }: { metrics: ServerMetrics | null }) {
  const { t } = useTranslation();
  const settings = useCardSettings();
  const procs = metrics?.processes;
  const top = procs?.top;
  const [sort, setSort] = useState<ProcSort>("cpu");
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState(false);
  const rows = useMemo(
    () => viewProcesses(top ?? [], sort, query, tree),
    [top, sort, query, tree],
  );
  const head = (s: ProcSort, text: string, right = false) => (
    <th
      scope="col"
      aria-sort={sort !== s ? "none" : s === "pid" ? "ascending" : "descending"}
      className={right ? "text-right" : "text-left"}
    >
      <button
        type="button"
        onClick={() => setSort(s)}
        className={
          "font-bold uppercase " + (sort === s ? "text-accent-brand" : "")
        }
      >
        {text}
      </button>
    </th>
  );

  return (
    <MetricCard
      title={t("hostMetrics.processes")}
      icon={<Cpu className="size-3.5" />}
      scroll
    >
      {settings.showDetails !== false && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {procs?.total != null && (
            <span>
              <span className="font-bold text-foreground">{procs.total}</span>{" "}
              <span className="text-muted-foreground">
                {t("hostMetrics.processesTotal")}
              </span>
            </span>
          )}
          {procs?.running != null && (
            <span>
              <span className="font-bold text-accent-brand">
                {procs.running}
              </span>{" "}
              <span className="text-muted-foreground">
                {t("hostMetrics.processesRunning")}
              </span>
            </span>
          )}
          {metrics?.cpu?.load && (
            <span className="text-muted-foreground">
              {t("hostMetrics.processesLoad")}{" "}
              <span className="font-mono text-foreground">
                {metrics.cpu.load.map((l) => l.toFixed(2)).join(" ")}
              </span>
            </span>
          )}
          {metrics?.uptime?.formatted && (
            <span className="font-mono text-muted-foreground">
              {metrics.uptime.formatted}
            </span>
          )}
        </div>
      )}
      <div className="mb-2 flex items-center gap-1.5">
        <PanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t("hostMetrics.processesSearch")}
          fill
        />
        <button
          type="button"
          aria-pressed={tree}
          onClick={() => setTree((v) => !v)}
          className={
            "h-7 shrink-0 border border-border px-2 text-[10px] font-bold uppercase " +
            (tree ? "text-accent-brand" : "text-muted-foreground")
          }
        >
          {t("hostMetrics.processesTree")}
        </button>
      </div>
      {!top || top.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {t("hostMetrics.noProcessesFound")}
        </span>
      ) : rows.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {t("hostMetrics.processesNoMatch")}
        </span>
      ) : (
        <table className="w-full table-fixed font-mono text-[11px]">
          <thead className="border-b border-border text-[10px] text-muted-foreground">
            <tr>
              {head("pid", "PID")}
              <th scope="col" className="w-6 text-left">
                S
              </th>
              {head("cpu", "CPU%", true)}
              {head("mem", "MEM%", true)}
              <th
                scope="col"
                className="w-1/2 pl-2 text-left font-bold uppercase"
              >
                {t("hostMetrics.processesCommand")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ proc: p, depth }) => (
              <tr key={p.pid}>
                <td className="text-muted-foreground">{p.pid}</td>
                <td
                  className={
                    p.state === "R"
                      ? "text-accent-brand"
                      : "text-muted-foreground"
                  }
                >
                  {p.state ?? ""}
                </td>
                <td className="text-right">{p.cpu}</td>
                <td className="text-right">{p.mem}</td>
                <td
                  className="truncate"
                  style={{ paddingLeft: 8 + depth * 10 }}
                >
                  {p.command}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </MetricCard>
  );
}
