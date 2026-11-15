import { request, Agent } from "node:https";
import { request as proxyRequest } from "node:http";
import { connect } from "node:tls";
import { Readable } from "node:stream";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  prohibitedSourceAddress,
  managedOpenShellNetwork,
  type HostResolver,
} from "./net-policy.js";
import { publicUrl } from "./sources.js";

/** The same validated DNS snapshot supplies the socket lookup; there is no second resolution. */
export async function pinnedLookup(
  host: string,
  resolver: HostResolver = (h) => lookup(h, { all: true }),
) {
  const addresses = await resolver(host);
  if (
    !addresses.length ||
    addresses.some((a) => prohibitedSourceAddress(a.address))
  )
    throw new Error("公開 IP アドレス以外へ接続できません");
  const address = addresses[0]!.address,
    family = isIP(address);
  return (
    _host: string,
    options: unknown,
    callback: (...args: any[]) => void,
  ) => {
    if ((options as { all?: boolean })?.all)
      callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** Credential-free, manual-redirect GET. Proxy mode requires gateway IP enforcement. */
export const publicFetch: typeof fetch = async (input, init = {}) => {
  if (typeof input !== "string" && !(input instanceof URL))
    throw new Error("公開取得はURLを指定してください");
  const url = publicUrl(String(input));
  if (
    (init.method ?? "GET") !== "GET" ||
    init.body ||
    init.redirect !== "manual"
  )
    throw new Error("公開取得はmanual redirectのGETのみです");
  const headers = new Headers(init.headers);
  if ([...headers.keys()].some((k) => !["accept", "user-agent"].includes(k)))
    throw new Error("公開取得に認証・任意headerは渡せません");
  const lookup = await pinnedLookup(url.hostname);
  init.signal?.throwIfAborted();
  const proxyValue = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (managedOpenShellNetwork() && !proxyValue) {
    // Transparent OpenShell egress owns DNS pinning and real-destination checks.
    // Use Node's standard HTTP stack through that inspected TLS boundary.
    return fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      credentials: "omit",
      signal: init.signal,
    });
  }
  headers.set("accept-encoding", "identity");
  const agent = new Agent({ keepAlive: false });
  if (proxyValue) {
    // A configured proxy resolves the target itself. Hardened OpenShell policy
    // restricts allowed_ips to public ranges at the actual CONNECT destination.
    // Outside that managed boundary, refuse a proxy rather than weaken pinning.
    if (
      process.env.WEB_HARNESS_MANAGED_WORKER !== "codex" &&
      process.env.WEB_HARNESS_MANAGED_WORKER !== "pi"
    )
      throw new Error(
        "公開取得のproxyは管理されたOpenShell workerでのみ利用できます",
      );
    const proxy = new URL(proxyValue);
    if (proxy.protocol !== "http:" || proxy.username || proxy.password)
      throw new Error("未対応の公開取得proxy設定です");
    agent.createConnection = ((
      _options: unknown,
      callback: (
        error: Error | null,
        socket?: ReturnType<typeof connect>,
      ) => void,
    ) => {
      let settled = false;
      const finish = (
        error: Error | null,
        socket?: ReturnType<typeof connect>,
      ) => {
        if (settled) return;
        settled = true;
        callback(error, socket);
      };
      const tunnel = proxyRequest({
        hostname: proxy.hostname,
        port: proxy.port || 80,
        method: "CONNECT",
        path: `${url.hostname}:443`,
        signal: init.signal ?? undefined,
        headers: { Host: `${url.hostname}:443` },
      });
      tunnel.once("error", (e) => finish(e));
      tunnel.once("connect", (response, socket, head) => {
        if (response.statusCode !== 200 || head.length) {
          socket.destroy();
          finish(
            new Error(
              `公開取得proxyが接続を拒否しました: ${response.statusCode}`,
            ),
          );
          return;
        }
        const tls = connect({
          socket,
          servername: url.hostname,
          rejectUnauthorized: true,
        });
        const abort = () => tls.destroy(new Error("公開取得を中断しました"));
        init.signal?.addEventListener("abort", abort, { once: true });
        tls.once("close", () =>
          init.signal?.removeEventListener("abort", abort),
        );
        tls.once("error", (e) => finish(e));
        tls.once("secureConnect", () => finish(null, tls));
        if (init.signal?.aborted) abort();
      });
      tunnel.end();
      return undefined;
    }) as typeof agent.createConnection;
  }
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        agent,
        method: "GET",
        headers: Object.fromEntries(headers),
        lookup,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const responseHeaders = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2)
          responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const status = res.statusCode ?? 502;
        res.once("close", () => agent.destroy());
        const body = [204, 205, 304].includes(status)
          ? null
          : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        if (!body) res.resume();
        resolve(new Response(body, { status, headers: responseHeaders }));
      },
    );
    req.once("error", (error) => {
      agent.destroy();
      reject(error);
    });
    req.end();
  });
};
