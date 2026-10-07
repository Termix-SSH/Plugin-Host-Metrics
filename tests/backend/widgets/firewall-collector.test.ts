import { describe, expect, it } from "vitest";
import { parseUfwStatus } from "../../../src/backend/widgets/firewall-collector.js";

const ACTIVE = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80,443/tcp                 ALLOW IN    192.168.1.0/24
OpenSSH                    LIMIT IN    Anywhere
53/udp                     ALLOW OUT   Anywhere
22/tcp (v6)                ALLOW IN    Anywhere (v6)
`;

describe("parseUfwStatus", () => {
  it("reads an active ufw into input and output chains", () => {
    const result = parseUfwStatus(ACTIVE)!;
    expect(result.type).toBe("ufw");
    expect(result.status).toBe("active");
    const [input, output] = result.chains;
    expect(input.policy).toBe("DENY");
    expect(output.policy).toBe("ALLOW");
    expect(input.rules[0]).toMatchObject({
      target: "ALLOW",
      protocol: "tcp",
      dport: "22",
      source: "0.0.0.0/0",
    });
    expect(input.rules[1]).toMatchObject({
      dport: "80,443",
      source: "192.168.1.0/24",
    });
    expect(input.rules[2]).toMatchObject({ target: "LIMIT", extra: "OpenSSH" });
    expect(input.rules).toHaveLength(4);
    expect(output.rules[0]).toMatchObject({ protocol: "udp", dport: "53" });
  });

  it("reports an inactive ufw and ignores other output", () => {
    expect(parseUfwStatus("Status: inactive\n")).toEqual({
      type: "ufw",
      status: "inactive",
      chains: [],
    });
    expect(parseUfwStatus("ufw: command not found")).toBeNull();
  });
});
