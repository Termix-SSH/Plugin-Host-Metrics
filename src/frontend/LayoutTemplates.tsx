import { useEffect, useId, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  EmptyState,
  FormFooter,
  InlineView,
  ListRow,
  PanelList,
  Select2,
  Field,
  Input,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { Copy, Trash2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { useHostMetricsApi } from "./host-metrics-api";
import { extractError } from "./cards/managers/useManagerData";
import {
  MAX_TEMPLATE_HOSTS,
  type LayoutTemplate,
  type LayoutTemplateHost,
  type LayoutTemplateApplyResult,
} from "../shared/layout-templates.js";

export function LayoutTemplates({
  layout,
  cardLabel,
  onClose,
  onApply,
}: {
  layout: import("../shared/host-metrics.js").HostMetricsLayout;
  cardLabel: (id: string) => string;
  onClose: () => void;
  onApply: (
    template: LayoutTemplate,
    hostIds: number[],
  ) => Promise<LayoutTemplateApplyResult[]>;
}) {
  const api = useHostMetricsApi();
  const fieldId = useId();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const alive = useRef(false);
  const pending = useRef(false);
  const [templates, setTemplates] = useState<LayoutTemplate[]>([]);
  const [hosts, setHosts] = useState<LayoutTemplateHost[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<LayoutTemplateApplyResult[] | null>(
    null,
  );
  const template = templates.find((item) => String(item.id) === templateId);
  const shown = hosts.filter((host) =>
    `${host.name} ${host.folder ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const text = (key: string, values?: Record<string, string | number>) =>
    t(`hostMetrics.layoutTemplates.${key}`, values);
  const explain = (code: string) =>
    [
      "invalid_id",
      "invalid_template",
      "invalid_hosts",
      "template_not_found",
      "access_denied",
      "save_failed",
    ].includes(code)
      ? text(`errors.${code}`)
      : code;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [saved, eligible] = await Promise.all([
        api.getLayoutTemplates(),
        api.getLayoutTemplateHosts(),
      ]);
      if (!alive.current) return;
      setTemplates(saved);
      setHosts(eligible);
      setSelected((previous) =>
        previous.filter((id) => eligible.some((host) => host.id === id)),
      );
    } catch (err) {
      if (alive.current) {
        setHosts([]);
        setSelected([]);
        setError(explain(extractError(err, t).message));
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      if (alive.current) setError(explain(extractError(err, t).message));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const create = () =>
    run(async () => {
      const saved = await api.createLayoutTemplate({
        name: name.trim(),
        layout,
      });
      if (!alive.current) return;
      setTemplates((previous) => [...previous, saved]);
      setTemplateId(String(saved.id));
      setName("");
      setResults(null);
    });
  const remove = () =>
    run(async () => {
      if (
        !template ||
        !(await confirm({
          title: text("deleteTitle"),
          description: text("deleteDescription", { name: template.name }),
          confirmLabel: text("delete"),
        }))
      )
        return;
      if (!alive.current) return;
      await api.deleteLayoutTemplate(template.id);
      if (!alive.current) return;
      setTemplates((previous) =>
        previous.filter((item) => item.id !== template.id),
      );
      setTemplateId("");
      setResults(null);
    });
  const apply = () =>
    run(async () => {
      if (!template || !selected.length) return;
      if (
        !(await confirm({
          title: text("applyTitle", { count: selected.length }),
          description: (
            <div className="space-y-2">
              <p>
                {text("applyDescription", {
                  name: template.name,
                  count: template.layout.slots.length,
                })}
              </p>
              <ul className="max-h-40 overflow-auto text-xs">
                {hosts
                  .filter((host) => selected.includes(host.id))
                  .map((host) => (
                    <li key={host.id}>
                      {host.name}
                      {host.folder ? ` (${host.folder})` : ""}
                    </li>
                  ))}
              </ul>
            </div>
          ),
          confirmLabel: text("apply"),
          destructive: true,
        }))
      )
        return;
      if (!alive.current) return;
      const applied = await onApply(template, selected);
      if (!alive.current) return;
      setResults(applied);
      setSelected(
        applied.filter((result) => result.error).map((result) => result.hostId),
      );
    });
  const toggle = (id: number) => {
    setResults(null);
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : previous.length < MAX_TEMPLATE_HOSTS
          ? [...previous, id]
          : previous,
    );
  };

  return (
    <InlineView
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
      onBeforeClose={() => !pending.current}
      title={text("title")}
      icon={<Copy className="size-4" />}
      footer={
        <FormFooter
          onCancel={busy ? undefined : onClose}
          cancelLabel={t("common.cancel")}
          onSave={apply}
          saveLabel={text("apply")}
          saving={busy}
          disabled={loading || !template || selected.length === 0}
          status={text("selected", {
            count: selected.length,
            max: MAX_TEMPLATE_HOSTS,
          })}
        />
      }
    >
      {error && (
        <div role="alert" className="text-xs text-destructive">
          {error}
          {loading ? null : (
            <Button variant="ghost" size="xs" disabled={busy} onClick={load}>
              {text("retry")}
            </Button>
          )}
        </div>
      )}
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {text("loading")}
        </p>
      ) : (
        <>
          <section className="flex flex-col gap-2 border-b border-border pb-3">
            <Field
              label={text("name")}
              htmlFor={`${fieldId}-name`}
              hint={text("createHint", { count: layout.slots.length })}
            >
              <Input
                id={`${fieldId}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
                maxLength={100}
              />
            </Field>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={busy || !name.trim() || name.trim().length > 100}
              onClick={create}
            >
              {text("create")}
            </Button>
          </section>
          <div className="flex items-end gap-2">
            <Field
              label={text("template")}
              htmlFor={`${fieldId}-template`}
              className="min-w-0 flex-1"
            >
              <Select2
                id={`${fieldId}-template`}
                aria-label={text("template")}
                value={templateId}
                disabled={busy || !templates.length}
                onChange={(event) => {
                  setTemplateId(event.target.value);
                  setResults(null);
                }}
              >
                <option value="">{text("choose")}</option>
                {templates.map((item) => (
                  <option key={item.id} value={String(item.id)}>
                    {item.name}
                  </option>
                ))}
              </Select2>
            </Field>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy || !template}
              title={text("deleteTitle")}
              aria-label={text("deleteTitle")}
              onClick={remove}
            >
              <Trash2 className="size-3.5 text-accent-brand" />
            </Button>
          </div>
          {!templates.length && (
            <EmptyState title={text("empty")} hint={text("emptyHint")} />
          )}
          {template && (
            <section
              aria-label={text("preview")}
              className="border border-border"
            >
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {text("previewHint", {
                  count: template.layout.slots.length,
                })}
              </p>
              <PanelList>
                {[...template.layout.slots]
                  .sort((a, b) => a.order - b.order)
                  .map((slot) => (
                    <ListRow
                      key={slot.id}
                      title={cardLabel(slot.id)}
                      meta={
                        <div className="space-y-1">
                          <p>
                            {text("dimensions", {
                              width:
                                slot.w != null
                                  ? text("span", { count: slot.w })
                                  : text("legacySpan", { count: slot.colSpan }),
                              height:
                                slot.height != null
                                  ? String(slot.height)
                                  : text("auto"),
                            })}
                          </p>
                          {Object.entries(slot.settings ?? {}).map(
                            ([key, value]) => (
                              <p key={key}>
                                {t(`hostMetrics.cardSettings.${key}`)}:{" "}
                                {typeof value === "boolean"
                                  ? text(value ? "on" : "off")
                                  : t(`hostMetrics.cardSettings.${value}`)}
                              </p>
                            ),
                          )}
                        </div>
                      }
                    />
                  ))}
              </PanelList>
            </section>
          )}
          <Field label={text("search")} htmlFor={`${fieldId}-search`}>
            <Input
              id={`${fieldId}-search`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={busy}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={
                busy ||
                !shown.length ||
                new Set([...selected, ...shown.map((host) => host.id)]).size >
                  MAX_TEMPLATE_HOSTS
              }
              onClick={() => {
                setSelected((previous) => [
                  ...new Set([...previous, ...shown.map((host) => host.id)]),
                ]);
                setResults(null);
              }}
            >
              {text("selectShown")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || !selected.length}
              onClick={() => {
                setSelected([]);
                setResults(null);
              }}
            >
              {text("clear")}
            </Button>
          </div>
          <PanelList
            className="max-h-64 overflow-auto border border-border"
            empty={<EmptyState title={text("noHosts")} />}
          >
            {shown.map((host) => (
              <ListRow
                key={host.id}
                title={
                  <label htmlFor={`${fieldId}-host-${host.id}`}>
                    {host.name}
                  </label>
                }
                meta={host.folder}
                leading={
                  <div className="flex shrink-0 items-center pl-2">
                    <Checkbox
                      id={`${fieldId}-host-${host.id}`}
                      aria-label={text("selectHost", { name: host.name })}
                      checked={selected.includes(host.id)}
                      disabled={
                        busy ||
                        (!selected.includes(host.id) &&
                          selected.length >= MAX_TEMPLATE_HOSTS)
                      }
                      onCheckedChange={() => toggle(host.id)}
                    />
                  </div>
                }
              />
            ))}
          </PanelList>
          <p className="text-xs text-muted-foreground">{text("behavior")}</p>
          {results && (
            <section aria-label={text("results")}>
              <p role="status" className="text-xs">
                {text("summary", {
                  success: results.filter((result) => !result.error).length,
                  failed: results.filter((result) => result.error).length,
                })}
              </p>
              <PanelList>
                {results.map((result) => (
                  <ListRow
                    key={result.hostId}
                    title={
                      hosts.find((host) => host.id === result.hostId)?.name ??
                      String(result.hostId)
                    }
                    tone={result.error ? "destructive" : "muted"}
                    meta={
                      result.error
                        ? explain(result.error) === result.error
                          ? text("failed")
                          : explain(result.error)
                        : text("result")
                    }
                  />
                ))}
              </PanelList>
            </section>
          )}
        </>
      )}
    </InlineView>
  );
}
