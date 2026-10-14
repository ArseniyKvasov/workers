import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

const BLOCKED_HOST_PATTERNS = [/\.internal$/i, /\.local$/i, /^localhost$/i];

export interface EgressConfig {
  /** Allowed hostnames (exact or wildcard "*.example.com"). Empty = deny all egress. */
  allowedDomains: string[];
  /** Whether private/internal IPs are always blocked (default true). */
  blockPrivateIps?: boolean;
  /** Abort outbound fetches after this long (default 30s). */
  timeoutMs?: number;
  /** Maximum outbound request body size (default 10 MB). */
  maxRequestBytes?: number;
}

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressBlockedError";
  }
}

function matchesAllowlist(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((domain) => {
    if (domain === "*") return true;
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(1); // ".example.com"
      return hostname.endsWith(suffix) || hostname === domain.slice(2);
    }
    return hostname === domain;
  });
}

function isPrivateIp(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPrivateIp(normalized.slice(7));
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fe80:") || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("ff");
  }
  if (isIP(normalized) !== 4) return true;

  const octets = normalized.split(".").map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true;
  if (a === 198 && b === 51 && octets[2] === 100) return true;
  if (a === 203 && b === 0 && octets[2] === 113) return true;
  return false;
}

/**
 * Outbound fetch guard wired as workerd's outboundService: enforces the
 * allowlist, blocks SSRF targets, and meters egress bytes.
 */
async function pinnedFetch(
  url: URL,
  original: Request,
  body: ArrayBuffer | null,
  address: string,
  timeoutMs: number
): Promise<Response> {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = new Headers(original.headers);
  headers.set("host", url.host);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => { requestHeaders[key] = value; });

  return new Promise((resolve, reject) => {
    const req = transport({
      protocol: url.protocol,
      hostname: address,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: original.method,
      headers: requestHeaders,
      ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      rejectUnauthorized: true,
    }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
        else if (value !== undefined) responseHeaders.set(key, value);
      }
      const stream = Readable.toWeb(res) as unknown as ReadableStream;
      resolve(new Response(stream, { status: res.statusCode ?? 502, statusText: res.statusMessage, headers: responseHeaders }));
    });
    req.once("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`egress request timed out after ${timeoutMs}ms`)));
    if (body) req.write(Buffer.from(body));
    req.end();
  });
}

export function createOutboundService(
  workerId: string,
  config: EgressConfig,
  hooks: { onEgressBytes?: (workerId: string, bytes: number) => void } = {}
): (request: Request) => Promise<Response> {
  const blockPrivate = config.blockPrivateIps ?? true;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxRequestBytes = config.maxRequestBytes ?? 10 * 1024 * 1024;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

    if (!matchesAllowlist(hostname, config.allowedDomains)) {
      throw new EgressBlockedError(`egress blocked: "${hostname}" is not in the allowlist`);
    }
    let pinnedAddress = hostname;
    if (blockPrivate) {
      if (isIP(hostname) && isPrivateIp(hostname)) {
        throw new EgressBlockedError(`egress blocked: private IP "${hostname}"`);
      }
      if (BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname)) || BLOCKED_HOSTNAMES.has(hostname)) {
        throw new EgressBlockedError(`egress blocked: internal host "${hostname}"`);
      }
      // Resolve once and use the selected address for the actual socket. This
      // closes the DNS-check/fetch TOCTOU window and rejects rebinding to private IPs.
      if (!isIP(hostname)) {
        try {
          const addresses = await lookup(hostname, { all: true, verbatim: true });
          const publicAddress = addresses.find(({ address }) => !isPrivateIp(address))?.address;
          if (!publicAddress) throw new EgressBlockedError(`egress blocked: "${hostname}" resolves only to private IPs`);
          pinnedAddress = publicAddress;
        } catch (error) {
          if (error instanceof EgressBlockedError) throw error;
          throw new EgressBlockedError(`egress blocked: DNS resolution failed for "${hostname}"`);
        }
      }
    }

    // Meter and cap request body bytes before forwarding upstream.
    const declaredBodyLength = Number(request.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declaredBodyLength) && declaredBodyLength > maxRequestBytes) {
      throw new EgressBlockedError(`egress blocked: request body exceeds ${maxRequestBytes} bytes`);
    }
    const body = request.body ? await request.clone().arrayBuffer() : null;
    if (body && body.byteLength > maxRequestBytes) {
      throw new EgressBlockedError(`egress blocked: request body exceeds ${maxRequestBytes} bytes`);
    }
    hooks.onEgressBytes?.(workerId, body?.byteLength ?? 0);

    // Never let a hung upstream pin a worker isolate indefinitely. The custom
    // request uses the DNS-pinned address while preserving Host and TLS SNI.
    return pinnedFetch(url, request, body, pinnedAddress, timeoutMs);
  };
}
