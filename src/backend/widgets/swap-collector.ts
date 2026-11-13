import type { Client } from "ssh2";
import {
  execCommand,
  type HostPlatform,
} from "@termix-ssh/plugin-sdk/host-commands";
import { parseSwapMeminfo, type SwapMetrics } from "../../shared/swap.js";
import type { MetricsLogger } from "../log.js";

export async function collectSwapMetrics(
  client: Client,
  platform: HostPlatform,
  log: MetricsLogger,
): Promise<SwapMetrics | null> {
  if (platform !== "linux") return null;
  try {
    const { stdout, code } = await execCommand(client, "cat /proc/meminfo");
    if (code !== 0) throw new Error(`Swap collection exited with code ${code}`);
    return parseSwapMeminfo(stdout);
  } catch (error) {
    log.warn("Swap metrics unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
