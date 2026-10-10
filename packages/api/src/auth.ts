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

  /** Validate a bearer token; returns the auth context or null. */
  async authenticate(token: string | null): Promise<AuthContext | null> {
    if (!token || !token.startsWith("wpk_")) return null;

    // Key format: wpk_<prefix>_<secret>; the base64url prefix itself may
    // contain underscores, so the prefix is everything before the LAST "_".
    const lastUnderscore = token.lastIndexOf("_");
    if (lastUnderscore <= 4) return null;
    const prefix = token.slice(4, lastUnderscore);

    const record = await this.apiKeys.findByPrefix(prefix);
    if (!record || record.revokedAt) return null;

    const expected = record.hash;
    const actual = hashKey(token);
    const matches = expected.length === actual.length
      ? timingSafeEqualStr(expected, actual)
      : false;

    if (!matches) return null;

    await this.apiKeys.touch(record.id);
    return { keyId: record.id, keyName: record.name };
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
