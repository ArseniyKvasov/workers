import { createHash, randomBytes } from "node:crypto";
import type { ApiKeysRepository } from "@platform/catalog";

/**
 * API key authentication. Keys are generated as "wpk_<prefix>_<secret>",
 * stored bcrypt-free with sha256 (key space is 192 bits of entropy, so a fast
 * hash is acceptable) and looked up by prefix then constant-time compared.
 */
export interface AuthContext {
  keyId: string;
  keyName: string;
}

const PREFIX_LEN = 12;

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(PREFIX_LEN).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const key = `wpk_${prefix}_${secret}`;
  return { key, prefix, hash: hashKey(key) };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

export class AuthService {
  constructor(private readonly apiKeys: ApiKeysRepository) {}

  /** Validate a bearer token; returns the auth context or null.
   *
   *  Read errors (DB unreachable) propagate to the caller so the HTTP layer
   *  can answer 503 SERVICE_UNAVAILABLE instead of 401 — a key must never be
   *  reported "invalid" just because postgres is briefly unreachable.
   *  The `last_used_at` touch is best-effort: its failure never fails auth.
   */
  async authenticate(token: string | null): Promise<AuthContext | null> {
    if (!token || !token.startsWith("wpk_")) return null;

    // Key format: wpk_<prefix>_<secret>. Both parts are base64url and MAY
    // contain underscores, so the prefix must be split positionally: 12
    // random bytes encode to exactly 16 base64url chars (no padding).
    const PREFIX_B64_LEN = 16;
    if (token.length <= 4 + PREFIX_B64_LEN + 1) return null;
    if (token[4 + PREFIX_B64_LEN] !== "_") return null;
    const prefix = token.slice(4, 4 + PREFIX_B64_LEN);

    const record = await this.apiKeys.findByPrefix(prefix);
    if (!record || record.revokedAt) return null;

    const expected = record.hash;
    const actual = hashKey(token);
    const matches = expected.length === actual.length
      ? timingSafeEqualStr(expected, actual)
      : false;

    if (!matches) return null;

    try {
      await this.apiKeys.touch(record.id);
    } catch {
      // best-effort usage accounting — auth itself already succeeded
    }
    return { keyId: record.id, keyName: record.name };
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export { timingSafeEqualStr };
