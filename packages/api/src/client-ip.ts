import type { Context } from "hono";

/**
 * Client IP resolution with reverse-proxy awareness. x-forwarded-for is only
 * honored when the direct peer (socket remote address) is in the trusted
 * proxy list; otherwise it is attacker-controlled and ignored.
 *
 * TRUSTED_PROXIES entries: exact IPv4/IPv6 or IPv4 CIDR (a.b.c.d/nn).
 */
export function parseTrustedProxies(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || !/^\d+$/.test(part)) return null;
    result = result * 256 + octet;
  }
  return result;
}

export function isTrustedProxy(peer: string, trustedProxies: string[]): boolean {
  if (trustedProxies.length === 0) return false;
  // node reports IPv4-mapped IPv6 as ::ffff:a.b.c.d — normalize both ways.
  const normalized = peer.replace(/^::ffff:/, "");
  for (const entry of trustedProxies) {
    if (entry === peer || entry === normalized) return true;
    const cidrMatch = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(entry);
    if (cidrMatch) {
      const network = ipv4ToInt(cidrMatch[1]!);
      const addr = ipv4ToInt(normalized);
      if (network === null || addr === null) continue;
      const bits = Number(cidrMatch[2]!);
      if (bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (network & mask) === (addr & mask);
    }
  }
  return false;
}

/**
 * Resolve the client IP for a request. Returns the socket peer address when
 * the peer is not a trusted proxy; when it is, walks x-forwarded-for from the
 * right and returns the first hop outside the trusted list.
 */
export function getClientIp(c: Context, trustedProxies: string[]): string {
  // @hono/node-server exposes the raw node req on env.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const peer = incoming?.socket?.remoteAddress ?? "";

  if (!isTrustedProxy(peer, trustedProxies)) {
    return peer || "unknown";
  }

  const forwarded = c.req.header("x-forwarded-for");
  if (!forwarded) return peer || "unknown";
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!isTrustedProxy(hop, trustedProxies)) return hop;
  }
  return peer || "unknown";
}
