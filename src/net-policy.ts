import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkNavigation } from "./sources.js";
export function privateAddress(ip: string): boolean {
  if (ip.includes(":"))
    return !/^2[0-9a-f]{3}:/i.test(ip) && !/^3[0-9a-f]{3}:/i.test(ip);
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
export type HostResolver = (host: string) => Promise<{ address: string }[]>;
export async function publicTarget(
  value: string,
  hosts: string[],
  resolveHost: HostResolver = (host) => lookup(host, { all: true }),
): Promise<string> {
  const url = checkNavigation(value, hosts);
  const addresses = await resolveHost(new URL(url).hostname);
  if (
    !addresses.length ||
    addresses.some((a) => !isIP(a.address) || privateAddress(a.address))
  )
    throw new Error("公開 IP アドレス以外へ接続できません");
  return url;
}
