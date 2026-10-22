import {
  execElevated,
  execCommand,
} from "@termix-ssh/plugin-sdk/host-commands";
import {
  isValidPort,
  isValidIpProtocol,
  isValidFirewallTarget,
  type IpProtocol,
  type FirewallTarget,
} from "./validation.js";
import type { Router } from "express";
import { readFirewall } from "../widgets/firewall-collector.js";
import { managerHandler, ManagerInputError } from "./route-helpers.js";
import type { ManagerRoutesDeps } from "./types.js";
import {
  readManagement,
  mutateManaged,
  withFirewallLock,
} from "./firewall-management.js";

export interface FirewallRuleSpec {
  protocol: IpProtocol;
  port: number;
  target: FirewallTarget;
}

/**
 * Build an iptables add/delete for an INPUT rule. We only ever touch INPUT for a
 * specific dport with an explicit target, and never the chain policy, so an
 * existing ESTABLISHED/SSH rule is left intact.
 */
export function buildIptablesRuleCommand(
  op: "add" | "delete",
  spec: FirewallRuleSpec,
): string {
  const flag = op === "add" ? "-A" : "-D";
  return `iptables ${flag} INPUT -p ${spec.protocol} --dport ${spec.port} -j ${spec.target}`;
}

export function buildNftRuleCommand(
  op: "add" | "delete",
  spec: FirewallRuleSpec,
): string {
  // The route verifies this hooked chain exists before using the helper.
  const rule = `${spec.protocol} dport ${spec.port} ${spec.target.toLowerCase()}`;
  if (op === "add") return `nft add rule inet filter input ${rule}`;
  // nft only deletes by handle, so look up the first matching rule's handle.
  return (
    `rules=$(nft -a list chain inet filter input) && ` +
    `handle=$(printf '%s\\n' "$rules" | ` +
    `awk '$0 ~ /^[[:space:]]*${rule} # handle [0-9]+$/ {print $NF; exit}') && ` +
    `[ -n "$handle" ] && nft delete rule inet filter input handle "$handle"`
  );
}

const UFW_ACTIONS: Record<string, string> = {
  ACCEPT: "allow",
  DROP: "deny",
  REJECT: "reject",
};

export function buildUfwRuleCommand(
  op: "add" | "delete",
  spec: FirewallRuleSpec,
): string {
  const action = UFW_ACTIONS[spec.target.toUpperCase()] ?? "deny";
  const rule = `${action} ${spec.port}/${spec.protocol}`;
  return op === "add" ? `ufw ${rule}` : `ufw delete ${rule}`;
}

export function registerFirewallRoutes(
  app: Router,
  deps: ManagerRoutesDeps,
): void {
  const { validateHostId } = deps;
  const writeHandler = (
    operation: string,
    fn: Parameters<typeof managerHandler>[3],
  ) =>
    managerHandler(deps, "edit", operation, (client, host, req) =>
      withFirewallLock(Number(req.params.id), () => fn(client, host, req)),
    );
  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/firewall/{id}/manage:
   *   post:
   *     summary: Edit or delete an identified firewall rule, or change a default policy
   *     description: Requires edit access and a fresh snapshot from the firewall GET endpoint. Unsupported rules remain read-only. UFW replacements are not atomic; refresh after every attempt, including failures.
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [op, id, snapshot]
   *             properties:
   *               op: { type: string, enum: [edit, delete, policy] }
   *               id: { type: string, description: Rule or policy identity from the current management response. }
   *               snapshot: { type: string, description: Host-bound firewall snapshot from the current management response. }
   *               spec: { type: object, description: For edit only. A managed rule specification retaining its immutable fields. }
   *               value: { type: string, description: For policy only. One of the choices returned for that policy. }
   *     responses:
   *       200: { description: Mutation result; inspect success and output, then refresh. }
   *       400: { description: Invalid input, stale snapshot or unsupported operation. }
   *       403: { description: No edit access to the host, or elevation denied. }
   *       500: { description: Host operation failed; refresh to determine the current state. }
   */
  app.post(
    "/host-metrics/managers/firewall/:id/manage",
    validateHostId,
    writeHandler("firewall_manage", (client, host, req) =>
      mutateManaged(client, host.sudoPassword, Number(req.params.id), req.body),
    ),
  );
  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/firewall/{id}:
   *   get:
   *     summary: Read the host firewall (iptables, nftables or ufw)
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: The firewall type, status and rules. }
   *       400: { description: Invalid input. }
   *       403: { description: No access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.get(
    "/host-metrics/managers/firewall/:id",
    validateHostId,
    managerHandler(
      deps,
      "connect",
      "firewall_read",
      async (client, host, req) => {
        return (
          await readManagement(client, host.sudoPassword, Number(req.params.id))
        ).view;
      },
    ),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/firewall/{id}/rule:
   *   post:
   *     summary: Add a simple input rule (deletion requires the management endpoint)
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [op, protocol, port, target]
   *             properties:
   *               op: { type: string, enum: [add] }
   *               protocol: { type: string, enum: [tcp, udp] }
   *               port: { type: integer }
   *               target: { type: string, description: ACCEPT, DROP or REJECT }
   *     responses:
   *       200: { description: The command result and firewall backend used. }
   *       400: { description: Invalid input. }
   *       403: { description: No edit access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.post(
    "/host-metrics/managers/firewall/:id/rule",
    validateHostId,
    writeHandler("firewall_rule", async (client, host, req) => {
      const { op, protocol, port, target } = req.body as {
        op?: "add" | "delete";
        protocol?: string;
        port?: number;
        target?: string;
      };
      if (op !== "add" && op !== "delete") {
        throw new ManagerInputError("Invalid op");
      }
      if (!isValidIpProtocol(protocol))
        throw new ManagerInputError("Invalid protocol");
      if (!isValidPort(port)) throw new ManagerInputError("Invalid port");
      if (!isValidFirewallTarget(target))
        throw new ManagerInputError("Invalid target");

      if (op === "delete")
        throw new ManagerInputError(
          "Deletion requires a fresh numbered/handle rule identity and snapshot; use the management endpoint",
        );
      const spec: FirewallRuleSpec = {
        protocol,
        port: Number(port),
        target,
      };
      const state = await readManagement(
        client,
        host.sudoPassword,
        Number(req.params.id),
      );
      const fw = state.view;
      if (req.body?.snapshot !== undefined && req.body.snapshot !== fw.snapshot)
        throw new ManagerInputError(
          "Firewall changed. Refresh and review before adding a rule; no changes made",
        );
      if (
        fw.type === "ufw" &&
        (fw.status !== "active" ||
          fw.managementWarning ||
          fw.managedRules.some((r) =>
            r.readOnlyReason?.startsWith("Noncanonical"),
          ))
      )
        throw new ManagerInputError(
          "UFW additions require an active, verified canonical ruleset; no changes made",
        );
      let cmd: string;
      if (fw.status === "unknown")
        throw new Error("Unknown firewall state; no changes made");
      switch (fw.type) {
        case "ufw":
          cmd = buildUfwRuleCommand(op, spec);
          break;
        case "iptables":
          if (!fw.chains.some((c) => c.name === "INPUT"))
            throw new Error(
              "No supported iptables filter INPUT chain; no changes made",
            );
          cmd = buildIptablesRuleCommand(op, spec);
          break;
        case "nftables": {
          const result = await readFirewall(
            client,
            "nft",
            "-j list chain inet filter input",
            host.sudoPassword,
          );
          let ruleset;
          try {
            ruleset = JSON.parse(result?.stdout ?? "");
          } catch {
            throw new Error(
              "Cannot parse native nftables input chain topology; no changes made",
            );
          }
          if (
            result?.stderr.trim() ||
            !Array.isArray(ruleset?.nftables) ||
            !ruleset.nftables.some(
              (entry: { chain?: Record<string, unknown> }) => {
                const chain = entry?.chain;
                return (
                  chain?.family === "inet" &&
                  chain.table === "filter" &&
                  chain.name === "input" &&
                  chain.type === "filter" &&
                  chain.hook === "input" &&
                  typeof chain.prio === "number" &&
                  ["accept", "drop"].includes(String(chain.policy))
                );
              },
            )
          )
            throw new Error(
              "Native nftables changes require an existing inet filter input base chain with hook input; no changes made",
            );
          cmd = buildNftRuleCommand(op, spec);
          break;
        }
        default:
          throw new Error("No supported firewall backend; no changes made");
      }
      const result = await execElevated(
        client,
        `export LC_ALL=C; export PATH="/usr/sbin:/usr/bin:/sbin:/bin"; ${cmd}`,
        host.sudoPassword,
        {
          forceSudo: true,
        },
      );
      return {
        success: result.code === 0,
        output: result.stdout || result.stderr,
        backend: fw.type,
      };
    }),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/firewall/{id}/persist:
   *   post:
   *     summary: Save the current firewall rules so they survive a reboot
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: The save result. }
   *       400: { description: Invalid input. }
   *       403: { description: No edit access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.post(
    "/host-metrics/managers/firewall/:id/persist",
    validateHostId,
    writeHandler("firewall_persist", async (client, host, req) => {
      const state = await readManagement(
        client,
        host.sudoPassword,
        Number(req.params.id),
      );
      const fw = state.view;
      if (req.body?.snapshot !== undefined && req.body.snapshot !== fw.snapshot)
        throw new ManagerInputError(
          "Firewall changed. Refresh and review before saving; no rules saved",
        );
      if (fw.type === "ufw" && fw.status !== "unknown")
        return {
          success: true,
          output: "UFW rules are already persistent.",
          backend: fw.type,
        };
      if (fw.type === "nftables")
        throw new Error(
          "Native nftables persistence is not supported: save rules using the host's configured service; /etc/nftables.conf was not changed",
        );
      if (fw.type !== "iptables" || fw.status === "unknown")
        throw new Error("No supported firewall backend; no rules saved");

      const env =
        'export LC_ALL=C; export PATH="/usr/sbin:/usr/bin:/sbin:/bin"; ';
      const needsV6 = fw.policies.some((p) => p.family === "ipv6");
      const mechanism = await execCommand(
        client,
        env +
          "if command -v netfilter-persistent >/dev/null 2>&1 && test -x /usr/share/netfilter-persistent/plugins.d/15-ip4tables" +
          (needsV6
            ? " && test -x /usr/share/netfilter-persistent/plugins.d/25-ip6tables"
            : "") +
          "; then echo netfilter-persistent; " +
          (needsV6
            ? "else exit 1; fi"
            : "elif command -v service >/dev/null 2>&1 && test -x /etc/init.d/iptables; then echo service; else exit 1; fi"),
        15000,
      );
      if (
        mechanism.code !== 0 ||
        !(
          needsV6
            ? ["netfilter-persistent"]
            : ["netfilter-persistent", "service"]
        ).includes(mechanism.stdout.trim())
      )
        throw new Error(
          needsV6
            ? "No supported IPv4/IPv6 persistence mechanism found (netfilter-persistent requires both family plugins); no rules saved"
            : "No supported iptables persistence mechanism found (netfilter-persistent with its IPv4 plugin, or the iptables init script); no rules saved",
        );
      const cmd =
        mechanism.stdout.trim() === "netfilter-persistent"
          ? "netfilter-persistent save"
          : "service iptables save";
      const result = await execElevated(client, env + cmd, host.sudoPassword, {
        forceSudo: true,
      });
      return {
        success: result.code === 0,
        output: result.stdout || result.stderr,
        backend: fw.type,
      };
    }),
  );
}
