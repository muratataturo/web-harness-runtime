import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { checkNavigation } from "./sources.js";
import { existsSync } from "node:fs";
// Conservative public-web policy, not an exhaustive IANA routability registry.
// Special-purpose protocol ranges remain denied even where individual exceptions
// are globally reachable. Research workloads do not need these destinations.
const deniedV4 = new BlockList();
const v4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const;
for (const [network, prefix] of v4Ranges)
  deniedV4.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], // Protocol assignments, including Teredo and benchmarking.
  ["2001:db8::", 32], // Documentation.
  ["2002::", 16], // 6to4 embeds an IPv4 destination.
  ["3fff::", 20], // Documentation.
] as const)
  deniedV6.addSubnet(network, prefix, "ipv6");
/** Historical name: true means unsuitable for public research, including invalid IPs. */
export function privateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (!family || ip.includes("%")) return true;
  if (family === 4) return deniedV4.check(ip, "ipv4");
  // This also denies mapped IPv4, NAT64, local, multicast and unallocated space.
  return !globalV6.check(ip, "ipv6") || deniedV6.check(ip, "ipv6");
}
/** OpenShell MicroVM uses this supervisor-owned DNS pool for transparent egress.
 * This is a relay address, never an allowed real destination: the gateway's
 * allowed_ips list still excludes the entire pool. Outside a managed guest it
 * remains denied, even if an environment variable alone claims otherwise.
 */
export function managedSyntheticDnsAddress(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return (
    isIP(ip) === 4 &&
    parts[0] === 198 &&
    (parts[1] === 18 || parts[1] === 19) &&
    managedOpenShellNetwork()
  );
}
export function managedOpenShellNetwork(): boolean {
  return (
    process.platform === "linux" &&
    !!process.env.OPENSHELL_SANDBOX &&
    ["codex", "pi"].includes(process.env.WEB_HARNESS_MANAGED_WORKER ?? "") &&
    existsSync("/opt/openshell")
  );
}
export const prohibitedSourceAddress = (ip: string) =>
  privateAddress(ip) && !managedSyntheticDnsAddress(ip);
export type HostResolver = (host: string) => Promise<{ address: string }[]>;

// CIDR subtraction keeps exact-host proxy rules from reaching private DNS
// answers. The gateway, not the agent's preflight DNS result, enforces this list.
function subtractNetworks(
  base: bigint,
  bits: number,
  width: number,
  denied: [bigint, number][],
  format: (n: bigint) => string,
): string[] {
  const end = base + (1n << BigInt(width - bits));
  const overlaps = denied.filter(
    ([n, p]) => n < end && n + (1n << BigInt(width - p)) > base,
  );
  if (
    overlaps.some(([n, p]) => n <= base && n + (1n << BigInt(width - p)) >= end)
  )
    return [];
  if (!overlaps.length) return [`${format(base)}/${bits}`];
  const half = 1n << BigInt(width - bits - 1);
  return [
    ...subtractNetworks(base, bits + 1, width, overlaps, format),
    ...subtractNetworks(base + half, bits + 1, width, overlaps, format),
  ];
}
const ipv4Number = (s: string) =>
  s.split(".").reduce((n, b) => (n << 8n) + BigInt(b), 0n);
export const publicNetworkCidrs: readonly string[] = Object.freeze([
  ...subtractNetworks(
    0n,
    0,
    32,
    v4Ranges.map(([n, p]) => [ipv4Number(n), p]),
    (n) => [24n, 16n, 8n, 0n].map((b) => Number((n >> b) & 255n)).join("."),
  ),
  ...subtractNetworks(
    0x2000n << 112n,
    3,
    128,
    [
      [0x2001n << 112n, 23],
      [0x20010db8n << 96n, 32],
      [0x2002n << 112n, 16],
      [0x3fffn << 112n, 20],
    ],
    (n) =>
      Array.from({ length: 8 }, (_, i) =>
        ((n >> BigInt(112 - i * 16)) & 65535n).toString(16),
      ).join(":"),
  ),
]);
export async function publicTarget(
  value: string,
  hosts: string[],
  resolveHost: HostResolver = (host) => lookup(host, { all: true }),
): Promise<string> {
  const url = checkNavigation(value, hosts);
  const addresses = await resolveHost(new URL(url).hostname);
  if (
    !addresses.length ||
    addresses.some(
      (a) => !isIP(a.address) || prohibitedSourceAddress(a.address),
    )
  )
    throw new Error("公開 IP アドレス以外へ接続できません");
  return url;
}
