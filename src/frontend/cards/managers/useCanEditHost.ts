import { useCurrentUser, useHost } from "@termix-ssh/plugin-sdk/frontend";

/**
 * Whether the user may run actions that change the host (edit access or
 * more). Read-only views only need connect. The server checks it too.
 */
export function useCanEditHost(hostId: number | null): boolean {
  const host = useHost(hostId ?? undefined);
  const user = useCurrentUser();
  if (hostId == null) return false;
  if (user?.isAdmin) return true;
  if (!host || !host.isShared) return true;
  return host.permissionLevel === "edit" || host.permissionLevel === "manage";
}
