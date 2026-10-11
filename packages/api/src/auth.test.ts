import { describe, expect, it, vi } from "vitest";
import {
  AuthService,
  extractBearerToken,
  generateApiKey,
  hashKey,
} from "./auth.js";

function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    findByPrefix: vi.fn(async () => undefined),
    touch: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

describe("api key format", () => {
  it("generates wpk_ keys with matching sha256 hash", () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key.startsWith("wpk_")).toBe(true);
    expect(key.includes(prefix)).toBe(true);
    expect(hash).toBe(hashKey(key));
    expect(key.startsWith(`wpk_${prefix}_`)).toBe(true);
  });

  it("produces unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
  });
});

describe("extractBearerToken", () => {
  it("parses standard and case-insensitive headers", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});

describe("AuthService.authenticate", () => {
  it("accepts a valid, unrevoked key", async () => {
    const { key, prefix, hash } = generateApiKey();
    const touch = vi.fn(async () => {});
    const repo = makeRepo({
      findByPrefix: vi.fn(async (p: string) =>
        p === prefix ? { id: "k1", name: "test", prefix, hash, revokedAt: null } : undefined
      ),
      touch,
    });
    const service = new AuthService(repo);
    const ctx = await service.authenticate(key);
    expect(ctx).toEqual({ keyId: "k1", keyName: "test" });
    expect(touch).toHaveBeenCalledWith("k1");
  });

  it("rejects revoked keys", async () => {
    const { key, prefix, hash } = generateApiKey();
    const repo = makeRepo({
      findByPrefix: vi.fn(async () => ({
        id: "k1",
        name: "test",
        prefix,
        hash,
        revokedAt: new Date(),
      })),
    });
    expect(await new AuthService(repo).authenticate(key)).toBeNull();
  });

  it("rejects unknown prefixes without touching", async () => {
    const touch = vi.fn(async () => {});
    const repo = makeRepo({ findByPrefix: vi.fn(async () => undefined), touch });
    expect(await new AuthService(repo).authenticate("wpk_unknown_secret")).toBeNull();
    expect(touch).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens", async () => {
    const service = new AuthService(makeRepo());
    for (const token of [null, "", "garbage", "wpk_", "wpk_x"]) {
      expect(await service.authenticate(token as never)).toBeNull();
    }
  });

  it("rejects a key whose hash does not match", async () => {
    const { key, prefix } = generateApiKey();
    const repo = makeRepo({
      findByPrefix: vi.fn(async () => ({
        id: "k1",
        name: "test",
        prefix,
        hash: hashKey("wpk_other_secret"),
        revokedAt: null,
      })),
    });
    expect(await new AuthService(repo).authenticate(key)).toBeNull();
  });
});
