import { SmoothSparkline as Sparkline } from "../SmoothCharts";
import { Button, Select2 } from "@termix-ssh/plugin-sdk/ui";
import { useEffect, useMemo, useState } from "react";
import {
  HeartPulse,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Plus,
  Trash2,
  Play,
  Pencil,
} from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import { useHostMetricsApi } from "../../host-metrics-api";
import { useManagerData, extractError } from "./useManagerData";
import { ManagerCardShell } from "@termix-ssh/plugin-sdk/ui";

type ScriptKind = "status" | "number" | "text";

interface HealthCheck {
  id: string;
  name: string;
  type: "tcp" | "http" | "script";
  target: string;
  port?: number;
  path?: string;
  command?: string;
  kind?: ScriptKind;
  unit?: string;
  warn?: number | null;
  crit?: number | null;
  below?: boolean;
  dashboard?: boolean;
}
interface HealthResult {
  checkId: string;
  ok: boolean;
  latencyMs: number | null;
  detail: string;
  value?: number | null;
  level?: "ok" | "warn" | "crit";
}
interface HistoryRow {
  checkId: string;
  ts: string;
  ok: boolean;
  latencyMs: number | null;
  detail?: string | null;
}

const inputClass =
  "h-7 border border-border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring";

function optionalNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** What a check row shows next to its name. */
function checkSummary(check: HealthCheck): string {
  if (check.type === "tcp") return `${check.target}:${check.port}`;
  if (check.type === "script") return check.command ?? "";
  return check.target;
}

/** The numbers to chart for a check: latency, or a script's value. */
function chartValues(check: HealthCheck, rows: HistoryRow[]): number[] {
  if (check.type !== "script") return rows.map((h) => h.latencyMs ?? 0);
  if (check.kind !== "number") return [];
  return rows
    .map((h) => Number.parseFloat(h.detail ?? ""))
    .filter((v) => Number.isFinite(v));
}
interface HealthData {
  checks: HealthCheck[];
  intervalSeconds?: number;
  results: HealthResult[];
  history: HistoryRow[];
}

function newCheck(): HealthCheck {
  return {
    id: `c_${Math.random().toString(36).slice(2, 9)}`,
    name: "",
    type: "tcp",
    target: "",
    port: 80,
  };
}

export function HealthCheckCard({ hostId }: { hostId: number | null }) {
  const { managerPost } = useHostMetricsApi();
  const { t } = useTranslation();
  const { data, loading, error, refresh } = useManagerData<HealthData>(
    hostId,
    "health",
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HealthCheck[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (data?.checks && !editing) setDraft(data.checks);
  }, [data?.checks, editing]);

  useEffect(() => {
    if (data?.intervalSeconds && !editing) {
      setIntervalMinutes(Math.max(1, Math.round(data.intervalSeconds / 60)));
    }
  }, [data?.intervalSeconds, editing]);

  const byCheck = useMemo(() => {
    const map = new Map<string, HistoryRow[]>();
    for (const h of data?.history ?? []) {
      const arr = map.get(h.checkId) ?? [];
      arr.push(h);
      map.set(h.checkId, arr);
    }
    return map;
  }, [data?.history]);

  const save = async () => {
    if (hostId == null) return;
    for (const c of draft) {
      const missing =
        c.type === "script"
          ? !c.name.trim() || !c.command?.trim()
          : !c.name.trim() || !c.target.trim();
      if (missing) {
        toast.error(t("hostMetrics.managers.healthMissingFields"));
        return;
      }
    }
    setSaving(true);
    try {
      const res = await managerPost<{ success: boolean }>(
        hostId,
        "health",
        {
          checks: draft,
          intervalSeconds:
            Math.min(1440, Math.max(1, Math.round(intervalMinutes) || 5)) * 60,
        },
        "config",
      );
      if (res.success) {
        toast.success(t("hostMetrics.managers.healthSaved"));
        setEditing(false);
        refresh();
      } else {
        toast.error(t("hostMetrics.managers.actionFailed"));
      }
    } catch (e) {
      toast.error(extractError(e, t).message);
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (hostId == null) return;
    setRunning(true);
    try {
      await managerPost(hostId, "health", {}, "run");
      refresh();
    } catch (e) {
      toast.error(extractError(e, t).message);
    } finally {
      setRunning(false);
    }
  };

  const updateDraft = (id: string, patch: Partial<HealthCheck>) =>
    setDraft((d) => d.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  return (
    <ManagerCardShell
      title={t("hostMetrics.managers.healthCheck")}
      icon={<HeartPulse className="size-3.5" />}
      loading={loading}
      error={error}
      onRefresh={refresh}
      headerExtra={
        editing ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setEditing(false);
                setDraft(data?.checks ?? []);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={saving}
              onClick={save}
            >
              {t("common.save")}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="xs"
              disabled={running || (data?.checks?.length ?? 0) === 0}
              onClick={runNow}
            >
              <Play className="size-3" />
              {t("hostMetrics.managers.healthRun")}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
              <Pencil className="size-3" />
              {t("common.edit")}
            </Button>
          </>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("hostMetrics.managers.healthInterval")}
            <input
              type="number"
              min={1}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="h-7 w-16 border border-border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          {draft.map((c) => (
            <div
              key={c.id}
              className="flex flex-col gap-1.5 border border-border bg-muted/20 p-2"
            >
              <div className="flex items-center gap-1.5">
                <input
                  value={c.name}
                  onChange={(e) => updateDraft(c.id, { name: e.target.value })}
                  placeholder={t("hostMetrics.managers.healthName")}
                  className="h-7 flex-1 border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <Select2
                  value={c.type}
                  onChange={(e) => {
                    const type = e.target.value as HealthCheck["type"];
                    updateDraft(
                      c.id,
                      type === "script"
                        ? { type, kind: c.kind ?? "status" }
                        : { type },
                    );
                  }}
                  className="h-7 border border-border bg-background px-1 text-xs"
                >
                  <option value="tcp">TCP</option>
                  <option value="http">HTTP</option>
                  <option value="script">
                    {t("hostMetrics.managers.healthScript")}
                  </option>
                </Select2>
                <button
                  onClick={() =>
                    setDraft((d) => d.filter((x) => x.id !== c.id))
                  }
                  className="flex size-7 items-center justify-center text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              {c.type === "script" ? (
                <div className="flex flex-col gap-1.5">
                  <textarea
                    value={c.command ?? ""}
                    onChange={(e) =>
                      updateDraft(c.id, { command: e.target.value })
                    }
                    placeholder={t("hostMetrics.managers.healthCommand")}
                    rows={2}
                    className="min-h-14 resize-y border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Select2
                      value={c.kind ?? "status"}
                      onChange={(e) =>
                        updateDraft(c.id, {
                          kind: e.target.value as ScriptKind,
                        })
                      }
                      className="h-7 border border-border bg-background px-1 text-xs"
                    >
                      <option value="status">
                        {t("hostMetrics.managers.healthKindStatus")}
                      </option>
                      <option value="number">
                        {t("hostMetrics.managers.healthKindNumber")}
                      </option>
                      <option value="text">
                        {t("hostMetrics.managers.healthKindText")}
                      </option>
                    </Select2>
                    {c.kind === "number" && (
                      <>
                        <input
                          value={c.unit ?? ""}
                          onChange={(e) =>
                            updateDraft(c.id, { unit: e.target.value })
                          }
                          placeholder={t("hostMetrics.managers.healthUnit")}
                          className={`${inputClass} w-14`}
                        />
                        <input
                          type="number"
                          value={c.warn ?? ""}
                          onChange={(e) =>
                            updateDraft(c.id, {
                              warn: optionalNumber(e.target.value),
                            })
                          }
                          placeholder={t("hostMetrics.managers.healthWarn")}
                          className={`${inputClass} w-20`}
                        />
                        <input
                          type="number"
                          value={c.crit ?? ""}
                          onChange={(e) =>
                            updateDraft(c.id, {
                              crit: optionalNumber(e.target.value),
                            })
                          }
                          placeholder={t("hostMetrics.managers.healthCrit")}
                          className={`${inputClass} w-20`}
                        />
                        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={c.below === true}
                            onChange={(e) =>
                              updateDraft(c.id, { below: e.target.checked })
                            }
                          />
                          {t("hostMetrics.managers.healthBelow")}
                        </label>
                      </>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground/70">
                    {t(
                      `hostMetrics.managers.healthKindHint.${c.kind ?? "status"}`,
                    )}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <input
                    value={c.target}
                    onChange={(e) =>
                      updateDraft(c.id, { target: e.target.value })
                    }
                    placeholder={t("hostMetrics.managers.healthTarget")}
                    className="h-7 flex-1 border border-border bg-background px-2 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                  />
                  {c.type === "tcp" ? (
                    <input
                      type="number"
                      value={c.port ?? ""}
                      onChange={(e) =>
                        updateDraft(c.id, { port: Number(e.target.value) })
                      }
                      placeholder={t("hostMetrics.ports.port")}
                      className="h-7 w-16 border border-border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                    />
                  ) : (
                    <input
                      value={c.path ?? ""}
                      onChange={(e) =>
                        updateDraft(c.id, { path: e.target.value })
                      }
                      placeholder="/health"
                      className="h-7 w-24 border border-border bg-background px-1.5 font-mono text-xs outline-none focus:ring-1 focus:ring-ring"
                    />
                  )}
                </div>
              )}
              <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={c.dashboard === true}
                  onChange={(e) =>
                    updateDraft(c.id, { dashboard: e.target.checked })
                  }
                />
                {t("hostMetrics.managers.healthDashboard")}
              </label>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setDraft((d) => [...d, newCheck()])}
          >
            <Plus className="size-3" />
            {t("hostMetrics.managers.healthAddCheck")}
          </Button>
        </div>
      ) : (data?.checks?.length ?? 0) === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <span className="text-xs text-muted-foreground/60">
            {t("hostMetrics.managers.noHealthChecks")}
          </span>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Plus className="size-3" />
            {t("hostMetrics.managers.healthAddCheck")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {(data?.checks ?? []).map((check) => {
            const result = data?.results?.find((r) => r.checkId === check.id);
            const hist = (byCheck.get(check.id) ?? []).slice().reverse();
            const chart = chartValues(check, hist);
            const level =
              result?.level ?? (result ? (result.ok ? "ok" : "crit") : null);
            const upPct =
              hist.length > 0
                ? Math.round(
                    (hist.filter((h) => h.ok).length / hist.length) * 100,
                  )
                : null;
            return (
              <div
                key={check.id}
                className="flex flex-col gap-1 border border-border bg-muted/20 p-2"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {level === "ok" ? (
                      <CheckCircle2 className="size-3.5 text-accent-brand" />
                    ) : level === "warn" ? (
                      <AlertTriangle className="size-3.5 text-warning" />
                    ) : (
                      <XCircle className="size-3.5 text-destructive" />
                    )}
                    <span className="text-xs font-semibold">{check.name}</span>
                    <span className="max-w-48 truncate font-mono text-[10px] text-muted-foreground/60">
                      {checkSummary(check)}
                    </span>
                  </div>
                  <span className="flex gap-2 font-mono text-[10px] text-muted-foreground">
                    <span
                      className={
                        level === "warn"
                          ? "text-warning"
                          : level === "crit" && check.type === "script"
                            ? "text-destructive"
                            : undefined
                      }
                    >
                      {check.type === "script"
                        ? (result?.detail ?? "-")
                        : result?.latencyMs != null
                          ? `${result.latencyMs}ms`
                          : "-"}
                    </span>
                    {upPct != null && <span>{upPct}%</span>}
                  </span>
                </div>
                {chart.length > 1 && (
                  <Sparkline data={chart} height={28} showLastDot={false} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </ManagerCardShell>
  );
}
