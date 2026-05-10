/**
 * Network policy construction for the Dungeon VM.
 *
 * Security invariant: the default posture is deny-all. Only hosts explicitly
 * listed in the merged DungeonConfig.allowedHosts reach the network. DNS
 * operates in synthetic mode — there is no DNS tunneling path.
 */

import type { DnsOptions, TcpOptions } from "@earendil-works/gondolin";

/**
 * Static DNS configuration for all Dungeon VMs.
 * Synthetic mode means the VM never issues real DNS queries; the host proxy
 * resolves names on its behalf, preventing DNS-based information leakage.
 */
export const DNS_CONFIG: DnsOptions = {
  mode: "synthetic",
  syntheticHostMapping: "per-host",
};

/**
 * Build the TCP port-forwarding configuration that exposes the Obsidian bridge
 * to the guest under a stable hostname.
 *
 * @param obsidianBridgePort Host-side port the bridge process is listening on.
 */
export function buildTcpConfig(obsidianBridgePort: number): TcpOptions {
  return {
    hosts: {
      [`obsidian-bridge:${obsidianBridgePort}`]: `127.0.0.1:${obsidianBridgePort}`,
    },
  };
}
