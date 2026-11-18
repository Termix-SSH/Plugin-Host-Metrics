import {
  parseLive as sdkParseLive,
  type LivePrev,
} from "@termix-ssh/plugin-sdk/host-scripts";
import { parseSwapMeminfo } from "../../shared/swap.js";
import type { LiveSample } from "../../shared/metrics.js";
export type { LivePrev };
export { liveCmd } from "@termix-ssh/plugin-sdk/host-scripts";

export function parseLive(
  stdout: string,
  prev?: LivePrev,
  now?: number,
): { sample: LiveSample; next: LivePrev } {
  const parsed = sdkParseLive(stdout, prev, now);
  // The SDK already includes swap in its meminfo section. Validate the raw
  // fields rather than treating its missing-field defaults as zero usage.
  const memory = stdout.split("@@\n")[1] ?? "";
  return {
    ...parsed,
    sample: {
      ...parsed.sample,
      ...(!/^Swap(?:Total|Free):/m.test(memory)
        ? {}
        : { swap: parseSwapMeminfo(memory) }),
    },
  };
}
