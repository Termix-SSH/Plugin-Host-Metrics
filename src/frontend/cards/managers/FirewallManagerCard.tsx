import {
  Button,
  Select2,
  ManagerCardShell,
  ManagerSearch,
  useConfirm,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@termix-ssh/plugin-sdk/ui";
import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Plus, Save, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import type {
  FirewallManagement,
  ManagedFirewallRule,
  ManagedFirewallPolicy,
  ManagedRuleSpec,
} from "../../../shared/firewall-management.js";
import { useHostMetricsApi } from "../../host-metrics-api";
import { useManagerData, extractError } from "./useManagerData";
import { useCanEditHost } from "./useCanEditHost";

const inputClass =
  "h-7 min-w-0 border border-border bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring";
function describe(s: ManagedRuleSpec): string {
  return `${s.family} ${s.action} ${s.direction} ${s.protocol} from ${s.source} port ${s.sourcePort} to ${s.destination} port ${s.port}${s.profile ? ` profile: ${s.profile}` : ""}${s.comment ? ` comment: ${s.comment}` : ""}`;
}

// A host switch also discards its editor and pending confirmation.
export function FirewallManagerCard({ hostId }: { hostId: number | null }) {
  return <FirewallManagerHost key={hostId ?? "none"} hostId={hostId} />;
}

function FirewallManagerHost({ hostId }: { hostId: number | null }) {
  const { managerPost } = useHostMetricsApi();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const canEdit = useCanEditHost(hostId);
  const { data, loading, error, refresh } = useManagerData<FirewallManagement>(
    hostId,
    "firewall",
  );
  const [proto, setProto] = useState<"tcp" | "udp">("tcp");
  const [port, setPort] = useState("");
  const [target, setTarget] = useState("ACCEPT");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{
    rule: ManagedFirewallRule;
    spec: ManagedRuleSpec;
    snapshot: string;
  } | null>(null);
  const [policyEditor, setPolicyEditor] = useState<{
    policy: ManagedFirewallPolicy;
    value: string;
    snapshot: string;
  } | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const editorElement = useRef<HTMLFieldSetElement>(null);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const current = useRef({ canEdit, snapshot: data?.snapshot });
  current.current = { canEdit, snapshot: data?.snapshot };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ready =
    canEdit &&
    !busy &&
    !loading &&
    !error &&
    data?.hostId === hostId &&
    !!data?.snapshot;

  const apply = async (
    action: string,
    body: Record<string, unknown>,
    description: string,
    snapshot = data?.snapshot,
  ) => {
    if (!ready || hostId == null || pending.current || !data) return;
    const payload = { ...structuredClone(body), snapshot };
    pending.current = true;
    setBusy(true);
    let attempted = false;
    try {
      const ok = await confirm({
        title: t("hostMetrics.managers.firewallConfirm"),
        description: (
          <div className="space-y-2">
            <p className="break-words whitespace-pre-wrap">{`Host ${hostId} · ${data.type}\n${description}`}</p>
            <p>{t("hostMetrics.managers.firewallRecoveryWarning")}</p>
            {data.type === "ufw" &&
              action === "manage" &&
              body.op === "edit" && (
                <p>{t("hostMetrics.managers.firewallNonAtomic")}</p>
              )}
          </div>
        ),
        confirmLabel: t("hostMetrics.managers.firewallApply"),
        destructive: true,
      });
      if (
        !ok ||
        !alive.current ||
        !current.current.canEdit ||
        current.current.snapshot !== snapshot
      )
        return;
      attempted = true;
      const res = await managerPost<{ success: boolean; output: string }>(
        hostId,
        "firewall",
        payload,
        action,
      );
      if (alive.current)
        toast[res.success ? "success" : "error"](
          res.output ||
            t(
              res.success
                ? "hostMetrics.managers.ruleApplied"
                : "hostMetrics.managers.actionFailed",
            ),
        );
    } catch (e) {
      if (alive.current) toast.error(extractError(e, t).message);
    } finally {
      pending.current = false;
      if (alive.current) {
        if (attempted) {
          setEditor(null);
          setPolicyEditor(null);
          await refresh();
        }
        setBusy(false);
      }
    }
  };

  const add = () => {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      toast.error(t("hostMetrics.managers.invalidPort"));
      return;
    }
    apply(
      "rule",
      { op: "add", protocol: proto, port: number, target },
      `Add INPUT: ${target} ${proto} port ${number}\n${data?.type === "ufw" ? "UFW default family behavior (IPv4 and IPv6 when enabled), any source/destination." : "Native default INPUT chain, IPv4 for iptables / inet for nftables, any source/destination."}`,
    );
  };
  const open = (rule: ManagedFirewallRule, trigger: HTMLElement) => {
    if (!ready || !rule.spec || !data) return;
    editorTrigger.current = trigger;
    setPolicyEditor(null);
    setEditor({ rule, spec: { ...rule.spec }, snapshot: data.snapshot });
  };
  const remove = (rule: ManagedFirewallRule) =>
    apply(
      "manage",
      { op: "delete", id: rule.id, snapshot: data?.snapshot },
      `Delete exactly:\n${rule.description}`,
    );
  const rows = (data?.managedRules ?? []).filter((r) =>
    `${r.description} ${r.chain}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <ManagerCardShell
      title={t("hostMetrics.managers.firewall")}
      icon={<ShieldCheck className="size-3.5" />}
      loading={loading}
      error={error}
      onRefresh={refresh}
      headerExtra={
        <>
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {data?.type}
          </span>
          {canEdit && data?.type === "iptables" && (
            <Button
              variant="ghost"
              size="xs"
              disabled={!ready}
              aria-label={t("hostMetrics.managers.firewallPersist")}
              title={t("hostMetrics.managers.firewallPersist")}
              onClick={() =>
                apply(
                  "persist",
                  {},
                  t("hostMetrics.managers.firewallPersistConfirm"),
                )
              }
            >
              <Save className="size-3" />
            </Button>
          )}
        </>
      }
    >
      {data && (
        <p className="mb-2 text-[10px] text-warning">
          {t(
            `hostMetrics.managers.${data.type === "ufw" ? "firewallUfwPersistence" : data.type === "nftables" ? "firewallNftPersistence" : "firewallNativePersistence"}`,
          )}
        </p>
      )}
      {data?.managementWarning && (
        <p role="status" className="mb-2 text-xs text-warning">
          {data.managementWarning}
        </p>
      )}
      {canEdit && data?.type !== "none" && (
        <fieldset
          disabled={!ready}
          className="mb-3 flex flex-col gap-2 border border-dashed border-border p-2"
        >
          <legend className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {t("hostMetrics.managers.addInputRule")}
          </legend>
          <div className="flex flex-wrap items-center gap-1.5">
            <Select2
              aria-label={t("hostMetrics.firewall.protocol")}
              value={proto}
              onChange={(e) => setProto(e.target.value as "tcp" | "udp")}
              className={`${inputClass} w-20`}
            >
              <option>tcp</option>
              <option>udp</option>
            </Select2>
            <input
              aria-label={t("hostMetrics.firewall.port")}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={t("hostMetrics.ports.port")}
              inputMode="numeric"
              className={`${inputClass} w-20`}
            />
            <Select2
              aria-label={t("hostMetrics.firewall.action")}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={`${inputClass} w-28`}
            >
              <option>ACCEPT</option>
              <option>DROP</option>
              <option>REJECT</option>
            </Select2>
            <Button
              variant="outline"
              size="xs"
              aria-label={t("hostMetrics.managers.addInputRule")}
              onClick={add}
            >
              <Plus className="size-3" />
            </Button>
          </div>
        </fieldset>
      )}
      <div className="mb-3 flex flex-wrap gap-2 empty:hidden">
        {(data?.policies ?? []).map((policy) => (
          <Button
            key={policy.id}
            variant="outline"
            size="xs"
            disabled={!ready}
            onClick={(event) => {
              editorTrigger.current = event.currentTarget;
              setEditor(null);
              setPolicyEditor({
                policy,
                value: policy.value,
                snapshot: data!.snapshot,
              });
            }}
          >
            {policy.chain} · {policy.family} ·{" "}
            {t("hostMetrics.firewall.policy")}: {policy.value}
          </Button>
        ))}
        {!data?.policies.length &&
          data?.chains.map((chain, i) => (
            <span key={i} className="text-xs text-muted-foreground">
              {chain.name}: {chain.policy} (
              {t("hostMetrics.managers.firewallReadOnly")})
            </span>
          ))}
      </div>
      <Dialog
        // The host confirmation must be the only modal while a change is pending.
        open={(!!editor || !!policyEditor) && !busy}
        onOpenChange={(open) => {
          if (!open && !pending.current) {
            setEditor(null);
            setPolicyEditor(null);
          }
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            editorElement.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!pending.current && editorTrigger.current?.isConnected)
              editorTrigger.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                editor
                  ? "hostMetrics.managers.firewallEdit"
                  : "hostMetrics.managers.firewallEditPolicy",
              )}
            </DialogTitle>
            <DialogDescription>
              {`Host ${hostId} · ${data?.type ?? ""}`}
              {policyEditor &&
                ` · ${policyEditor.policy.chain} · ${policyEditor.policy.family}`}
            </DialogDescription>
          </DialogHeader>
          {policyEditor && (
            <fieldset
              ref={editorElement}
              tabIndex={-1}
              disabled={!ready}
              className="min-w-0 space-y-3"
            >
              <legend className="sr-only">
                {t("hostMetrics.managers.firewallEditPolicy")} ·{" "}
                {policyEditor.policy.chain} · {policyEditor.policy.family}
              </legend>
              <Select2
                aria-label={t("hostMetrics.firewall.policy")}
                className={`${inputClass} w-28`}
                value={policyEditor.value}
                onChange={(e) =>
                  setPolicyEditor({ ...policyEditor, value: e.target.value })
                }
              >
                {policyEditor.policy.choices.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </Select2>
              <div className="flex justify-end gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={policyEditor.snapshot !== data?.snapshot}
                  onClick={() =>
                    apply(
                      "manage",
                      {
                        op: "policy",
                        id: policyEditor.policy.id,
                        value: policyEditor.value,
                        snapshot: policyEditor.snapshot,
                      },
                      `${policyEditor.policy.description ?? policyEditor.policy.chain} default policy · ${policyEditor.policy.family}: ${policyEditor.policy.value} → ${policyEditor.value}`,
                      policyEditor.snapshot,
                    )
                  }
                >
                  {t("hostMetrics.managers.firewallApply")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setPolicyEditor(null)}
                >
                  {t("hostMetrics.managers.firewallCancel")}
                </Button>
              </div>
            </fieldset>
          )}
          {editor && (
            <fieldset
              ref={editorElement}
              tabIndex={-1}
              disabled={!ready}
              className="min-w-0 space-y-3"
            >
              <legend className="sr-only">
                {t("hostMetrics.managers.firewallEdit")}
              </legend>
              <p className="break-words text-xs">{editor.rule.description}</p>
              <p className="text-[10px] text-muted-foreground">
                {t("hostMetrics.managers.firewallPreserved")}:{" "}
                {editor.spec.family} · {editor.spec.direction} ·{" "}
                {editor.spec.comment || "—"}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(
                  [
                    "action",
                    "protocol",
                    "source",
                    "destination",
                    "port",
                    "sourcePort",
                  ] as const
                ).map((field) => (
                  <label
                    key={field}
                    className="flex min-w-0 flex-col gap-1 text-xs"
                  >
                    {t(`hostMetrics.managers.firewallField_${field}`)}
                    {field === "action" || field === "protocol" ? (
                      <Select2
                        disabled={!!editor.spec.profile && field === "protocol"}
                        className={inputClass}
                        value={editor.spec[field]}
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            spec: { ...editor.spec, [field]: e.target.value },
                          })
                        }
                      >
                        {(field === "action"
                          ? data?.type === "ufw"
                            ? ["allow", "deny", "reject"]
                            : ["allow", "deny"]
                          : ["any", "tcp", "udp"]
                        ).map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </Select2>
                    ) : (
                      <input
                        className={inputClass}
                        value={editor.spec[field]}
                        readOnly={
                          (!!editor.spec.profile &&
                            ["port", "sourcePort"].includes(field)) ||
                          (data?.type === "nftables" &&
                            ["source", "destination"].includes(field))
                        }
                        onChange={(e) =>
                          setEditor({
                            ...editor,
                            spec: { ...editor.spec, [field]: e.target.value },
                          })
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={editor.snapshot !== data?.snapshot}
                  onClick={() =>
                    apply(
                      "manage",
                      {
                        op: "edit",
                        id: editor.rule.id,
                        spec: editor.spec,
                        snapshot: editor.snapshot,
                      },
                      `Old: ${editor.rule.description}\nNew: ${describe(editor.spec)}`,
                      editor.snapshot,
                    )
                  }
                >
                  {t("hostMetrics.managers.firewallApply")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setEditor(null)}
                >
                  {t("hostMetrics.managers.firewallCancel")}
                </Button>
              </div>
              {editor.snapshot !== data?.snapshot && (
                <p role="status" className="text-xs text-warning">
                  {t("hostMetrics.managers.firewallStale")}
                </p>
              )}
            </fieldset>
          )}
        </DialogContent>
      </Dialog>
      <ManagerSearch value={query} onChange={setQuery} />
      <div className="flex flex-col gap-1">
        {!!rows.length && (
          <div
            className={`grid grid-cols-[3.25rem_2.5rem_3.25rem_minmax(0,1fr)] gap-1.5 px-1 text-[10px] uppercase text-muted-foreground ${canEdit ? "pr-[4.25rem]" : ""}`}
            aria-hidden="true"
          >
            <span>{t("hostMetrics.firewall.action")}</span>
            <span>{t("hostMetrics.firewall.protocol")}</span>
            <span>{t("hostMetrics.firewall.port")}</span>
            <span>{t("hostMetrics.firewall.source")}</span>
          </div>
        )}
        {rows.map((rule) => (
          <div
            key={rule.id}
            className="flex flex-wrap items-center gap-x-1 border-b border-border/50 py-1 text-xs last:border-0"
          >
            <button
              type="button"
              disabled={!ready || !rule.spec}
              onClick={(event) => open(rule, event.currentTarget)}
              aria-label={`${t("hostMetrics.managers.firewallEdit")}: ${rule.description}`}
              title={rule.description}
              className="min-w-0 flex-1 basis-0 rounded-sm px-1 py-1 text-left font-mono outline-none hover:enabled:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
            >
              <span className="grid grid-cols-[3.25rem_2.5rem_3.25rem_minmax(0,1fr)] gap-1.5">
                <span className="break-words">{rule.target}</span>
                <span className="break-words">{rule.protocol}</span>
                <span className="break-all">{rule.dport || "—"}</span>
                <span className="min-w-0 break-all">{rule.source}</span>
              </span>
              <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                <span>{rule.family || rule.spec?.family || "—"}</span>
                <span>
                  {rule.direction || rule.spec?.direction || rule.chain}
                </span>
                {(rule.profile || rule.spec?.profile) && (
                  <span className="min-w-0 break-words">
                    {rule.profile || rule.spec?.profile}
                  </span>
                )}
              </span>
            </button>
            {canEdit && (
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="xs"
                  className="size-7 shrink-0 p-0 text-accent-brand hover:text-accent-brand focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={t("hostMetrics.managers.firewallEdit")}
                  title={t("hostMetrics.managers.firewallEdit")}
                  disabled={!ready || !rule.spec}
                  onClick={(event) => open(rule, event.currentTarget)}
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="size-7 shrink-0 p-0 text-accent-brand hover:text-accent-brand focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={t("hostMetrics.managers.firewallDelete")}
                  title={t("hostMetrics.managers.firewallDelete")}
                  disabled={!ready || !rule.spec}
                  onClick={() => remove(rule)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            )}
            {rule.readOnlyReason && (
              <div className="w-full min-w-0 text-[10px] text-muted-foreground">
                {data?.type !== "ufw" && (
                  <p className="break-all font-mono">{rule.description}</p>
                )}
                <p>
                  {t("hostMetrics.managers.firewallReadOnly")}:{" "}
                  {rule.readOnlyReason}
                </p>
              </div>
            )}
          </div>
        ))}
        {!data?.managedRules.length &&
          data?.chains.flatMap((chain, ci) =>
            chain.rules.map((rule, i) => (
              <p key={`${ci}:${i}`} className="break-words font-mono text-xs">
                {rule.chain} · {rule.target} · {rule.protocol} ·{" "}
                {rule.extra || rule.dport} · {rule.source} (
                {t("hostMetrics.managers.firewallReadOnly")})
              </p>
            )),
          )}
        {!rows.length && !data?.chains.some((c) => c.rules.length) && (
          <span className="text-xs text-muted-foreground">
            {t("hostMetrics.firewall.noRules")}
          </span>
        )}
      </div>
    </ManagerCardShell>
  );
}
