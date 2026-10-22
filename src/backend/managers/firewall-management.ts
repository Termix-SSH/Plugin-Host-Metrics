import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Client } from "ssh2";
import {
  execElevated,
  shellSingleQuote,
} from "@termix-ssh/plugin-sdk/host-commands";
import type {
  FirewallManagement,
  ManagedFirewallRule,
  ManagedRuleSpec,
} from "../../shared/firewall-management.js";
import type { FirewallMetrics } from "../../shared/stats-widgets.js";
import {
  collectFirewallMetrics,
  readFirewall,
} from "../widgets/firewall-collector.js";
import { ManagerInputError } from "./route-helpers.js";

const ENV = 'export LC_ALL=C; export PATH="/usr/sbin:/usr/bin:/sbin:/bin"; ';
const hash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, v) =>
        v && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
            )
          : v,
      ) ?? "undefined",
    )
    .digest("hex");
const quote = (args: (string | number)[]) =>
  args.map((v) => shellSingleQuote(String(v))).join(" ");
// nft rejects quoted table/chain names on argv, so only plain identifiers are
// accepted. shortcut: names needing nft escaping stay unmanageable, extend if reported.
const nftName = (name: unknown): string => {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_./-]{0,63}$/.test(name)
  )
    throw new ManagerInputError(
      "Unsupported nftables table or chain name; no changes made",
    );
  return name;
};
const locks = new Map<number, Promise<void>>();

/** One process-wide queue, shared by legacy, management and persistence writes. */
export async function withFirewallLock<T>(
  hostId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(hostId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(hostId, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(hostId) === current) locks.delete(hostId);
  }
}

// Read-only use of UFW 0.36.2's rule parser and numbered-identity implementation.
// shortcut: other UFW versions/layouts stay read-only until their parser is verified.
export const UFW_PROBE = `import gettext,json,pathlib,re,hashlib,subprocess
gettext.install('ufw')
assert subprocess.check_output(['/usr/sbin/ufw','--version'],text=True).splitlines()[0] == 'ufw 0.36.2', 'Unsupported UFW version'
from ufw.backend_iptables import UFWBackendIptables
b=UFWBackendIptables.__new__(UFWBackendIptables)
base=pathlib.Path('/etc/ufw')
b.files={'rules':str(base/'user.rules'),'rules6':str(base/'user6.rules'),'defaults':'/etc/default/ufw','conf':str(base/'ufw.conf')}
b._get_defaults()
b.loglevels={'off':0,'low':100,'medium':200,'high':300,'full':400}
b.chains={k:[] for k in ['before','user','after','misc']}
v6=b.use_ipv6()
for prefix in ['ufw']+(['ufw6'] if v6 else []):
 for loc in ['before','user','after']:
  b.chains[loc] += [prefix+'-'+loc+'-logging-'+direction for direction in ['input','output','forward']]
 b.chains['misc'] += [prefix+'-logging-deny',prefix+'-logging-allow']
b.rules=[]; b.rules6=[]
b._read_rules()
rules=b.get_rules()
numbers={id(r):n for n in range(1,len(rules)+1) if (r:=b.get_rule_by_number(n)) is not None}
fields=['action','protocol','dport','dst','sport','src','direction','forward','comment','v6','dapp','sapp','logtype','interface_in','interface_out']
rows=[dict({k:getattr(r,k) for k in fields},number=numbers.get(id(r)),group=r.get_app_tuple(),raw=r.format_rule()) for r in rules]
canonical=True
rawfiles=[]
for family,path in [(False,base/'user.rules')]+([(True,base/'user6.rules')] if v6 else []):
 text=path.read_text()
 rawfiles.append(re.sub(r'\\[\\d+:\\d+\\]','[0:0]','\\n'.join(l for l in text.splitlines() if not l.startswith('# Generated') and not l.startswith('# Completed'))))
 prefix='ufw6' if family else 'ufw'
 actual=[l.strip() for l in text.splitlines() if l.startswith('-')]
 expected=[]
 for r in rules:
  if r.v6!=family: continue
  suffix='forward' if r.forward else 'output' if r.direction=='out' else 'input'
  expected += [s.strip() for s in b._get_rules_from_formatted('-A '+prefix+'-user-'+suffix+' '+r.format_rule(),prefix,suffix)]
 for chain,args,query in b._get_logging_rules(b.defaults['loglevel']):
  if args and args[0]!='-D' and chain.startswith(prefix+'-'):
   expected.append(' '.join(args).replace('[','"[').replace('] ','] "'))
 has_limit=bool(re.search(r'^:'+prefix+r'-user-limit - ',text,re.M))
 if has_limit:
  if b.defaults['loglevel']!='off': expected.append('-A '+prefix+'-user-limit -m limit --limit 3/minute -j LOG --log-prefix "[UFW LIMIT BLOCK] "')
  expected += ['-A '+prefix+'-user-limit -j REJECT','-A '+prefix+'-user-limit-accept -j ACCEPT']
 names=[prefix+'-user-'+d for d in ['input','output','forward']]
 names += [prefix+'-'+loc+'-logging-'+d for loc in ['before','user','after'] for d in ['input','output','forward']]
 names += [prefix+'-logging-deny',prefix+'-logging-allow']
 if has_limit: names += [prefix+'-user-limit',prefix+'-user-limit-accept']
 declarations=[re.sub(r'\\[\\d+:\\d+\\]','[0:0]',l) for l in text.splitlines() if l.startswith(':')]
 # Reject all unrepresented executable content, including indented restore commands.
 canonical=canonical and all(not l.strip() or l.lstrip().startswith('#') or l.startswith(('-',':')) or l in ['*filter','COMMIT'] for l in text.splitlines())
 canonical=canonical and actual==expected and declarations==[':'+name+' - [0:0]' for name in names] and text.splitlines().count('*filter')==1 and text.splitlines().count('COMMIT')==1 and len(re.findall(r'^### tuple ###',text,re.M))==len([r for r in rules if r.v6==family])
paths=[pathlib.Path('/etc/default/ufw'),base/'ufw.conf',base/'before.rules',base/'after.rules']
if v6: paths += [base/'before6.rules',base/'after6.rules']
paths += sorted((base/'applications.d').glob('*'))
config=[(str(p),hashlib.sha256(p.read_bytes()).hexdigest()) for p in paths if p.is_file()]
print(json.dumps({'rows':rows,'canonical':canonical,'config':config,'rawfiles':rawfiles,'ipv6':v6}))`;

interface Identity {
  row: ManagedFirewallRule;
  backend: FirewallMetrics["type"];
  position: number;
  number?: number;
  chain: string;
  family: string;
  table?: string;
  handle?: number;
  key: unknown;
}
interface State {
  view: FirewallManagement;
  identities: Identity[];
  topology: unknown;
}

export function validateManagedSpec(value: unknown): ManagedRuleSpec {
  const s = value as ManagedRuleSpec;
  if (
    !s ||
    typeof s !== "object" ||
    Object.keys(s)
      .filter((k) => k !== "profile")
      .sort()
      .join() !==
      [
        "family",
        "direction",
        "action",
        "protocol",
        "source",
        "destination",
        "port",
        "sourcePort",
        "comment",
      ]
        .sort()
        .join()
  )
    throw new ManagerInputError("Invalid rule fields");
  if (
    !["ipv4", "ipv6", "inet"].includes(s.family) ||
    !["in", "out"].includes(s.direction) ||
    !["allow", "deny", "reject"].includes(s.action) ||
    !["tcp", "udp", "any"].includes(s.protocol)
  )
    throw new ManagerInputError(
      "Invalid family, direction, action or protocol",
    );
  for (const address of [s.source, s.destination]) {
    if (s.family === "inet" && address === "any") continue;
    if (typeof address !== "string")
      throw new ManagerInputError("Invalid address");
    const parts = address.split("/");
    const version = isIP(parts[0]);
    if (
      !version ||
      parts.length > 2 ||
      (s.family === "ipv4"
        ? version !== 4
        : s.family === "ipv6"
          ? version !== 6
          : true) ||
      (parts.length === 2 &&
        (!/^\d+$/.test(parts[1]) ||
          Number(parts[1]) > (version === 4 ? 32 : 128)))
    )
      throw new ManagerInputError(
        "Use an address/CIDR of the rule's existing family",
      );
  }
  for (const port of [s.port, s.sourcePort]) {
    if (port === "any") continue;
    if (
      typeof port !== "string" ||
      !/^\d+$/.test(port) ||
      Number(port) < 1 ||
      Number(port) > 65535
    )
      throw new ManagerInputError(
        "Only single ports (1-65535) or any are supported",
      );
  }
  if (
    typeof s.comment !== "string" ||
    s.comment.length > 128 ||
    /[\x00-\x1f\x7f]/.test(s.comment)
  )
    throw new ManagerInputError("Invalid comment");
  if (
    s.profile !== undefined &&
    (typeof s.profile !== "string" ||
      !s.profile ||
      s.profile.length > 128 ||
      /[\x00-\x1f\x7f]/.test(s.profile))
  )
    throw new ManagerInputError("Invalid application profile");
  return s;
}

function row(
  spec: ManagedRuleSpec,
  id: string,
  description: string,
): ManagedFirewallRule {
  return {
    id,
    description,
    spec,
    family: spec.family,
    direction: spec.direction,
    profile: spec.profile,
    chain: spec.direction === "in" ? "INPUT" : "OUTPUT",
    target: spec.action.toUpperCase(),
    protocol: spec.protocol,
    source: spec.source,
    destination: spec.destination,
    dport: spec.port,
    sport: spec.sourcePort,
  };
}
function supported(spec: ManagedRuleSpec): boolean {
  try {
    validateManagedSpec(spec);
    return true;
  } catch {
    return false;
  }
}
const blank = (
  family: ManagedRuleSpec["family"],
  direction: ManagedRuleSpec["direction"],
): ManagedRuleSpec => ({
  family,
  direction,
  action: "allow",
  protocol: "any",
  source: family === "ipv6" ? "::/0" : family === "inet" ? "any" : "0.0.0.0/0",
  destination:
    family === "ipv6" ? "::/0" : family === "inet" ? "any" : "0.0.0.0/0",
  port: "any",
  sourcePort: "any",
  comment: "",
});

export async function readManagement(
  client: Client,
  password: string | undefined,
  hostId: number,
): Promise<State> {
  const fw = await collectFirewallMetrics(client, password, true);
  const view: FirewallManagement = {
    ...fw,
    hostId,
    snapshot: "",
    managedRules: [],
    policies: [],
  };
  const identities: Identity[] = [];
  let topology: unknown = null;
  const add = (identity: Identity) => {
    identities.push(identity);
    view.managedRules.push(identity.row);
  };
  if (fw.type === "ufw" && fw.status === "active") {
    try {
      const result = await execElevated(
        client,
        ENV +
          "cd / && /usr/bin/python3 -I -B -c " +
          shellSingleQuote(UFW_PROBE),
        password,
        { forceSudo: true },
      );
      if (result.code !== 0 || result.stderr.trim())
        throw new Error(result.stderr || "UFW identity probe failed");
      const data = JSON.parse(result.stdout);
      if (
        !Array.isArray(data.rows) ||
        !Array.isArray(data.config) ||
        !Array.isArray(data.rawfiles) ||
        typeof data.ipv6 !== "boolean" ||
        typeof data.canonical !== "boolean"
      )
        throw new Error("Invalid UFW identity response");
      topology = {
        config: data.config,
        rawfiles: data.rawfiles,
        ipv6: data.ipv6,
      };
      if (!data.canonical)
        view.managementWarning =
          "Noncanonical UFW file: rule and policy mutations are disabled to preserve custom constraints.";
      const flowKey = (r: Record<string, unknown>) =>
        hash([
          r.v6,
          r.protocol,
          r.dport,
          r.dst,
          r.sport,
          r.src,
          r.direction,
          r.forward,
          r.dapp,
          r.sapp,
          r.interface_in,
          r.interface_out,
        ]);
      for (const [index, r] of data.rows.entries()) {
        const spec: ManagedRuleSpec = {
          family: r.v6 ? "ipv6" : "ipv4",
          direction: r.direction,
          action: r.action,
          protocol: r.protocol,
          source: r.src,
          destination: r.dst,
          port: r.dport,
          sourcePort: r.sport,
          comment: Buffer.from(r.comment, "hex").toString("utf8"),
          ...(r.dapp ? { profile: r.dapp } : {}),
        };
        const description = [
          spec.family,
          r.action,
          r.direction,
          r.protocol,
          `from ${r.src}:${r.sport}`,
          `to ${r.dst}:${r.dport}`,
          r.dapp && `profile ${r.dapp}`,
          r.sapp && `source profile ${r.sapp}`,
          r.logtype,
          r.interface_in,
          r.interface_out,
          spec.comment,
        ]
          .filter(Boolean)
          .join(" ");
        const item = row(spec, `ufw:${index}`, description);
        const singleProfile =
          !!r.dapp &&
          !r.sapp &&
          data.rows.filter(
            (other: { group: string }) => other.group === r.group,
          ).length === 1;
        if (
          !data.canonical ||
          data.rows.filter(
            (other: Record<string, unknown>) => flowKey(other) === flowKey(r),
          ).length !== 1 ||
          (r.dapp && !singleProfile) ||
          r.sapp ||
          r.logtype ||
          r.forward ||
          r.interface_in ||
          r.interface_out ||
          !Number.isInteger(r.number) ||
          r.number !== index + 1 ||
          !/^(?:[a-fA-F0-9]{2})*$/.test(r.comment) ||
          Buffer.from(spec.comment, "utf8").toString("hex") !==
            r.comment.toLowerCase() ||
          !supported(spec)
        ) {
          item.spec = undefined;
          item.readOnlyReason = !data.canonical
            ? "Noncanonical UFW file: manage on the host to preserve custom rules."
            : "Duplicate flows, multi-expansion/source profiles, rows after expanded groups, logging, LIMIT, routed/interface rules and port ranges are read-only; their constraints are preserved.";
        }
        add({
          row: item,
          backend: fw.type,
          position: index + 1,
          number: r.number,
          chain: item.chain,
          family: spec.family,
          key: r,
        });
      }
      for (const chain of fw.chains.filter((c) =>
        ["INPUT", "OUTPUT"].includes(c.name),
      ))
        // UFW policy changes restart the firewall, so a custom rules file must stay read-only.
        if (
          data.canonical &&
          ["ALLOW", "DENY", "REJECT"].includes(chain.policy)
        )
          view.policies.push({
            id: chain.name,
            chain: chain.name,
            family: data.ipv6 ? "IPv4 + IPv6" : "IPv4 (IPv6 disabled in UFW)",
            value: chain.policy.toLowerCase(),
            choices: ["allow", "deny", "reject"],
          });
    } catch {
      identities.length = 0;
      view.managedRules = [];
      view.policies = [];
      topology = null;
      view.managementWarning =
        "UFW identity unavailable (requires the verified UFW 0.36.2 Python layout and read access). Rules and policies are read-only.";
    }
  } else if (fw.type === "iptables") {
    const saves: Record<string, string> = {};
    for (const [family, tool] of [
      ["ipv4", "iptables-save"],
      ["ipv6", "ip6tables-save"],
    ]) {
      const result = await readFirewall(client, tool, "-t filter", password);
      if (!result) continue;
      if (result.stderr.trim() || /ufw[-_]|firewalld/i.test(result.stdout))
        throw new Error(
          "Ambiguous native IPv4/IPv6 ownership; no changes made",
        );
      const text = result.stdout
        .replace(/\[\d+:\d+\]/g, "[0:0]")
        .split("\n")
        .filter((l) => !l.startsWith("#"))
        .join("\n");
      saves[family] = text;
      const positions = new Map<string, number>();
      for (const line of text.split("\n")) {
        const policy = /^:(INPUT|OUTPUT) (ACCEPT|DROP) \[0:0\]$/.exec(line);
        if (policy)
          view.policies.push({
            id: `${family}:${policy[1]}`,
            chain: policy[1],
            family,
            value: policy[2],
            choices: ["ACCEPT", "DROP"],
          });
        const m = /^-A (\S+) (.+)$/.exec(line);
        if (!m) continue;
        const [, chain, raw] = m;
        const position = (positions.get(chain) ?? 0) + 1;
        positions.set(chain, position);
        const spec = blank(
          family as "ipv4" | "ipv6",
          chain === "OUTPUT" ? "out" : "in",
        );
        const args = raw.split(/\s+/);
        const seen = new Set<string>();
        let valid = ["INPUT", "OUTPUT"].includes(chain);
        for (let i = 0; i < args.length; i += 2) {
          const flag = args[i],
            value = args[i + 1];
          if (!value || (seen.has(flag) && flag !== "-m")) {
            valid = false;
            break;
          }
          seen.add(flag);
          if (flag === "-p" && ["tcp", "udp", "all"].includes(value))
            spec.protocol = value === "all" ? "any" : (value as "tcp" | "udp");
          else if (flag === "-s") spec.source = value;
          else if (flag === "-d") spec.destination = value;
          else if (flag === "--dport") spec.port = value;
          else if (flag === "--sport") spec.sourcePort = value;
          else if (flag === "-j" && ["ACCEPT", "DROP"].includes(value))
            spec.action = value === "ACCEPT" ? "allow" : "deny";
          else if (flag !== "-m" || !["tcp", "udp"].includes(value))
            valid = false;
        }
        valid =
          valid &&
          seen.has("-j") &&
          supported(spec) &&
          (spec.protocol !== "any" ||
            (spec.port === "any" && spec.sourcePort === "any")) &&
          (!seen.has("-m") ||
            args.every((v, i) => v !== "-m" || args[i + 1] === spec.protocol));
        const item = row(
          spec,
          `${family}:${chain}:${position}`,
          `${family} ${line}`,
        );
        if (!valid) {
          item.spec = undefined;
          // A failed subset parse is not evidence for the blank spec's defaults.
          item.chain = chain;
          item.target = item.protocol = item.source = item.destination = "—";
          item.dport = item.sport = undefined;
          item.direction = undefined;
          item.readOnlyReason =
            "Only lossless simple native INPUT/OUTPUT TCP/UDP rules are editable; additional matches, comments and targets remain read-only.";
        }
        add({
          row: item,
          backend: fw.type,
          position,
          chain,
          family,
          key: line,
        });
      }
    }
    topology = saves;
  } else if (fw.type === "nftables") {
    const result = await readFirewall(
      client,
      "nft",
      "-j list ruleset",
      password,
    );
    if (!result || result.stderr.trim())
      throw new Error("Cannot read exact nftables identities");
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data.nftables)) throw new Error("Invalid nftables JSON");
    const entries = data.nftables as Record<string, any>[];
    // Counters change with traffic; all other expressions and topology are significant.
    const stable = (value: any): any =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([k]) => k !== "metainfo")
                .map(([k, v]) => [
                  k,
                  k === "counter" && v && typeof v === "object"
                    ? stable(
                        Object.fromEntries(
                          Object.entries(v).filter(
                            ([field]) => !["packets", "bytes"].includes(field),
                          ),
                        ),
                      )
                    : stable(v),
                ]),
            )
          : value;
    topology = stable(entries);
    for (const entry of entries) {
      const c = entry.chain;
      if (
        !c ||
        c.type !== "filter" ||
        !["input", "output"].includes(c.hook) ||
        !["ip", "ip6", "inet"].includes(c.family) ||
        !["accept", "drop"].includes(c.policy) ||
        typeof c.prio !== "number" ||
        typeof c.table !== "string" ||
        typeof c.name !== "string"
      )
        continue;
      const related = entries.filter(
        (e) => e.chain?.hook === c.hook && e.chain?.family === c.family,
      );
      if (related.length === 1)
        view.policies.push({
          id: "nft:" + hash([c.family, c.table, c.name]),
          description: `${c.family} ${c.table} ${c.name} (hook ${c.hook})`,
          chain: c.hook.toUpperCase(),
          family: c.family,
          value: c.policy,
          choices: ["accept", "drop"],
        });
    }
    for (const entry of entries) {
      const r = entry.rule;
      if (!r) continue;
      const c = entries.find(
        (e) =>
          e.chain?.family === r.family &&
          e.chain.table === r.table &&
          e.chain.name === r.chain,
      )?.chain;
      const spec = blank(
        r.family === "ip" ? "ipv4" : r.family === "ip6" ? "ipv6" : "inet",
        c?.hook === "output" ? "out" : "in",
      );
      let valid =
        !!c &&
        c.type === "filter" &&
        ["input", "output"].includes(c.hook) &&
        ["ip", "ip6", "inet"].includes(r.family) &&
        typeof r.table === "string" &&
        typeof r.chain === "string" &&
        Number.isSafeInteger(r.handle) &&
        r.handle > 0 &&
        !r.comment &&
        Array.isArray(r.expr);
      const seen = new Set<string>();
      for (const e of r.expr ?? []) {
        if (Object.keys(e).length !== 1) {
          valid = false;
          continue;
        }
        if (e.accept === null || e.drop === null) {
          if (seen.has("verdict")) valid = false;
          seen.add("verdict");
          spec.action = e.accept === null ? "allow" : "deny";
          continue;
        }
        const m = e.match;
        const p = m?.left?.payload;
        if (
          m?.op !== "==" ||
          !p ||
          Object.keys(m).sort().join() !== "left,op,right" ||
          Object.keys(m.left).join() !== "payload" ||
          Object.keys(p).sort().join() !== "field,protocol" ||
          !["tcp", "udp"].includes(p.protocol) ||
          !["dport", "sport"].includes(p.field) ||
          !Number.isInteger(m.right)
        ) {
          valid = false;
          continue;
        }
        if (
          seen.has(p.field) ||
          (spec.protocol !== "any" && spec.protocol !== p.protocol)
        )
          valid = false;
        seen.add(p.field);
        spec.protocol = p.protocol;
        if (p.field === "dport") spec.port = String(m.right);
        else spec.sourcePort = String(m.right);
      }
      valid =
        valid &&
        seen.has("verdict") &&
        supported(spec) &&
        Object.keys(r).every((k) =>
          ["family", "table", "chain", "handle", "expr", "index"].includes(k),
        );
      const item = row(
        spec,
        "nft:" + hash([r.family, r.table, r.chain, r.handle]),
        `${r.family} ${r.table} ${r.chain} handle ${r.handle}: ${JSON.stringify(r.expr)}`,
      );
      if (!valid) {
        item.spec = undefined;
        item.chain = r.chain;
        item.target = item.protocol = item.source = item.destination = "—";
        item.dport = item.sport = undefined;
        item.direction = undefined;
        item.readOnlyReason =
          "Only simple native TCP/UDP port + accept/drop expressions are editable. Other matches, counters, comments and chains remain read-only.";
      }
      add({
        row: item,
        backend: fw.type,
        position: 0,
        chain: r.chain,
        family: r.family,
        table: r.table,
        handle: r.handle,
        key: stable(r),
      });
    }
  }
  view.snapshot = hash([
    hostId,
    fw.type,
    fw.status,
    fw.chains.map((c) => [c.name, c.policy]),
    topology,
    identities.map((i) => i.key),
  ]);
  return { view, identities, topology };
}

export function buildManagedCommand(
  identity: Identity,
  spec?: ManagedRuleSpec,
  ufwInsert = true,
): string {
  if (identity.backend === "ufw") {
    if (!spec) return "ufw --force delete " + identity.number;
    const args: (string | number)[] = [
      ...(ufwInsert ? ["insert", identity.number!] : []),
      spec.action,
      spec.direction,
    ];
    if (!spec.profile && spec.protocol !== "any")
      args.push("proto", spec.protocol);
    args.push("from", spec.source);
    if (spec.sourcePort !== "any") args.push("port", spec.sourcePort);
    args.push("to", spec.destination);
    if (spec.profile) args.push("app", spec.profile);
    else if (spec.port !== "any") args.push("port", spec.port);
    if (spec.comment) args.push("comment", spec.comment);
    return "ufw " + quote(args);
  }
  if (identity.backend === "iptables") {
    const args: (string | number)[] = [
      "-w",
      "5",
      "-t",
      "filter",
      spec ? "-R" : "-D",
      identity.chain,
      identity.position,
    ];
    if (spec) {
      if (spec.protocol !== "any") args.push("-p", spec.protocol);
      args.push("-s", spec.source, "-d", spec.destination);
      if (spec.port !== "any") args.push("--dport", spec.port);
      if (spec.sourcePort !== "any") args.push("--sport", spec.sourcePort);
      args.push("-j", spec.action === "allow" ? "ACCEPT" : "DROP");
    }
    return (
      (identity.family === "ipv6" ? "ip6tables " : "iptables ") + quote(args)
    );
  }
  const args: (string | number)[] = [
    spec ? "replace" : "delete",
    "rule",
    identity.family,
    identity.table!,
    identity.chain,
    "handle",
    identity.handle!,
  ];
  if (spec) {
    if (spec.port !== "any") args.push(spec.protocol, "dport", spec.port);
    if (spec.sourcePort !== "any")
      args.push(spec.protocol, "sport", spec.sourcePort);
    args.push(spec.action === "allow" ? "accept" : "drop");
  }
  args[3] = nftName(identity.table);
  args[4] = nftName(identity.chain);
  return "nft " + quote(args);
}

export async function mutateManaged(
  client: Client,
  password: string | undefined,
  hostId: number,
  body: Record<string, unknown>,
) {
  if (
    !body ||
    !["edit", "delete", "policy"].includes(String(body.op)) ||
    typeof body.snapshot !== "string" ||
    typeof body.id !== "string"
  )
    throw new ManagerInputError("Invalid management request");
  const fresh = await readManagement(client, password, hostId);
  if (body.snapshot !== fresh.view.snapshot)
    throw new ManagerInputError(
      "Firewall changed. Refresh and review the current rule/policy; no changes made.",
    );
  const execute = async (cmd: string) => {
    const result = await execElevated(client, ENV + cmd, password, {
      forceSudo: true,
    });
    if (result.code !== 0)
      throw new Error(
        result.stderr ||
          result.stdout ||
          "Firewall command failed; refresh before retrying",
      );
    return result;
  };
  if (body.op === "policy") {
    const policy = fresh.view.policies.find((p) => p.id === body.id);
    if (
      !policy ||
      typeof body.value !== "string" ||
      !policy.choices.includes(body.value)
    )
      throw new ManagerInputError("Unsupported policy or chain");
    if (body.value === policy.value)
      return { success: true, output: "Policy unchanged" };
    let command: string;
    if (fresh.view.type === "ufw")
      command =
        "ufw " +
        quote([
          "default",
          body.value,
          policy.chain === "INPUT" ? "incoming" : "outgoing",
        ]);
    else if (fresh.view.type === "iptables")
      command =
        (policy.family === "ipv6" ? "ip6tables " : "iptables ") +
        quote(["-w", "5", "-t", "filter", "-P", policy.chain, body.value]);
    else {
      const entries = fresh.topology as Record<string, any>[];
      const c = entries.find(
        (e) =>
          e.chain &&
          "nft:" + hash([e.chain.family, e.chain.table, e.chain.name]) ===
            body.id,
      )?.chain;
      if (!c) throw new ManagerInputError("Unsupported native chain");
      command =
        "nft " +
        quote([
          "add",
          "chain",
          c.family,
          nftName(c.table),
          nftName(c.name),
          "{",
          "policy",
          body.value,
          ";",
          "}",
        ]);
    }
    await execute(command);
    const after = await readManagement(client, password, hostId);
    if (
      after.view.type !== fresh.view.type ||
      after.view.policies.find((p) => p.id === body.id)?.value !== body.value ||
      hash(after.identities.map((i) => i.key)) !==
        hash(fresh.identities.map((i) => i.key))
    )
      throw new Error(
        "Policy command returned but the new policy could not be verified. Refresh; do not retry automatically.",
      );
    return { success: true, output: "Policy applied and re-read" };
  }
  const identity = fresh.identities.find((i) => i.row.id === body.id);
  if (!identity?.row.spec)
    throw new ManagerInputError("This rule is read-only; no changes made");
  const spec = body.op === "edit" ? validateManagedSpec(body.spec) : undefined;
  if (spec) {
    const old = identity.row.spec;
    if (
      spec.family !== old.family ||
      spec.direction !== old.direction ||
      spec.comment !== old.comment ||
      spec.profile !== old.profile
    )
      throw new ManagerInputError(
        "Family, direction, comment and profile identity must be preserved",
      );
    if (
      old.profile &&
      (spec.protocol !== old.protocol ||
        spec.port !== old.port ||
        spec.sourcePort !== old.sourcePort)
    )
      throw new ManagerInputError(
        "Profile protocol and ports must be preserved; edit the profile on the host",
      );
    if (
      identity.backend !== "ufw" &&
      ((spec.protocol === "any" &&
        (spec.port !== "any" || spec.sourcePort !== "any")) ||
        (identity.backend === "nftables" &&
          spec.protocol !== "any" &&
          spec.port === "any" &&
          spec.sourcePort === "any") ||
        spec.action === "reject" ||
        (spec.source !== old.source && identity.backend === "nftables") ||
        (spec.destination !== old.destination &&
          identity.backend === "nftables"))
    )
      throw new ManagerInputError("Unsupported native rule fields");
    if (hash(spec) === hash(old))
      return { success: true, output: "Rule unchanged" };
  }
  const beforeKeys = fresh.identities.map((i) => i.key);
  const index = fresh.identities.indexOf(identity);
  if (
    identity.backend === "ufw" &&
    spec &&
    hash({ ...identity.row.spec, action: spec.action }) === hash(spec)
  ) {
    // UFW 0.36.2 set_rule updates a unique matching flow's action in its existing slot.
    try {
      await execute(buildManagedCommand(identity, spec, false));
      const after = await readManagement(client, password, hostId);
      if (
        after.view.type !== "ufw" ||
        hash((after.topology as { config: unknown })?.config) !==
          hash((fresh.topology as { config: unknown })?.config) ||
        hash(after.identities[index]?.row.spec) !== hash(spec) ||
        hash(
          after.identities.filter((_, i) => i !== index).map((i) => i.key),
        ) !==
          hash(fresh.identities.filter((_, i) => i !== index).map((i) => i.key))
      )
        throw new Error(
          "Action update was not verified in the original position",
        );
      return {
        success: true,
        output: "UFW action updated in its existing position and re-read",
      };
    } catch (e) {
      throw new Error(
        `UFW action update may have partially applied; inspect refreshed rules before retrying. ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (identity.backend === "ufw" && spec) {
    try {
      await execute(buildManagedCommand(identity, spec));
      const inserted = await readManagement(client, password, hostId);
      const candidate = inserted.identities[index];
      const without = inserted.identities
        .filter((_, i) => i !== index)
        .map((i) => i.key);
      // Compare numbered identity separately: insertion legitimately renumbers later rows.
      const stableKeys = (keys: unknown[]) =>
        keys.map((k) => {
          const { number, ...rest } = k as Record<string, unknown>;
          return rest;
        });
      if (
        inserted.view.type !== "ufw" ||
        hash((inserted.topology as { config: unknown })?.config) !==
          hash((fresh.topology as { config: unknown })?.config) ||
        !candidate?.row.spec ||
        hash(candidate.row.spec) !== hash(spec) ||
        hash(stableKeys(without)) !== hash(stableKeys(beforeKeys))
      )
        throw new Error(
          "Insertion was skipped, reordered, expanded or unverified; original was NOT deleted",
        );
      const original = inserted.identities[index + 1];
      if (
        !original?.row.spec ||
        hash(stableKeys([original.key])) !== hash(stableKeys([identity.key]))
      )
        throw new Error(
          "Original identity could not be re-established; original was NOT deleted",
        );
      await execute(buildManagedCommand(original));
      const after = await readManagement(client, password, hostId);
      if (
        after.view.type !== "ufw" ||
        hash(stableKeys(after.identities.map((i) => i.key))) !==
          hash(
            stableKeys(
              inserted.identities
                .filter((_, i) => i !== index + 1)
                .map((i) => i.key),
            ),
          )
      )
        throw new Error("Final replacement could not be verified");
      return {
        success: true,
        output: "Non-atomic UFW replacement completed and re-read",
      };
    } catch (e) {
      throw new Error(
        `UFW edit is not atomic. It may have partially applied; inspect refreshed rules before any retry. ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  await execute(buildManagedCommand(identity, spec));
  const after = await readManagement(client, password, hostId);
  if (after.view.type !== fresh.view.type)
    throw new Error(
      "Firewall owner changed during action. Refresh and inspect the host.",
    );
  if (!spec) {
    // Numbered rules shift after deletion; compare ordered exact native contents.
    const keys = (ids: Identity[]) =>
      ids.map((i) => {
        if (i.backend !== "ufw") return i.key;
        const { number, ...rest } = i.key as Record<string, unknown>;
        return rest;
      });
    if (
      hash(keys(after.identities)) !==
      hash(keys(fresh.identities.filter((i) => i !== identity)))
    )
      throw new Error(
        "Deletion outcome could not be verified; inspect refreshed rules before retrying",
      );
  } else {
    const updated = after.identities.find((i) => i.row.id === identity.row.id);
    if (
      !updated?.row.spec ||
      hash(updated.row.spec) !== hash(spec) ||
      hash(after.view.policies) !== hash(fresh.view.policies) ||
      hash(
        after.identities
          .filter((i) => i.row.id !== identity.row.id)
          .map((i) => i.key),
      ) !==
        hash(fresh.identities.filter((i) => i !== identity).map((i) => i.key))
    )
      throw new Error(
        "Replacement outcome could not be verified; inspect refreshed rules before retrying",
      );
  }
  return { success: true, output: "Rule applied and re-read" };
}
