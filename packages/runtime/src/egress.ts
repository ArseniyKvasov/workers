import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
  if (ip === "::1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true; // link-local, ULA
  if (isIP(ip) !== 4) return ip.startsWith("::ffff:"); // IPv4-mapped handled below

  const octets = ip.split(".").map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true; // private, loopback, this-network
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 0 && octets[2] === 2) return true; // TEST-NET
  return false;
}

/**
 * Outbound fetch guard wired as workerd's outboundService: enforces the
 * allowlist, blocks SSRF targets, and meters egress bytes.
 */
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
    if (blockPrivate) {
      if (isIP(hostname) && isPrivateIp(hostname)) {
        throw new EgressBlockedError(`egress blocked: private IP "${hostname}"`);
      }
      if (BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname)) || BLOCKED_HOSTNAMES.has(hostname)) {
        throw new EgressBlockedError(`egress blocked: internal host "${hostname}"`);
      }
      // Resolve and check actual IPs (DNS rebinding protection)
      try {
        const addresses = await lookup(hostname, { all: true, verbatim: true });
        for (const { address } of addresses) {
          const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
          if (isPrivateIp(ip)) {
            throw new EgressBlockedError(`egress blocked: "${hostname}" resolves to private IP ${ip}`);
          }
        }
      } catch (error) {
        if (error instanceof EgressBlockedError) throw error;
        throw new EgressBlockedError(`egress blocked: DNS resolution failed for "${hostname}"`);
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

    // Never let a hung upstream pin a worker isolate indefinitely.
    return fetch(url, {
      method: request.method,
      headers: request.headers,
      body: body as ArrayBuffer | null,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
}
