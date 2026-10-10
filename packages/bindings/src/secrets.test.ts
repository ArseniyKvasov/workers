import { describe, expect, it } from "vitest";
import { SecretCrypto, SecretsBinding } from "./secrets.js";

describe("SecretCrypto", () => {
  it("encrypts and decrypts round-trip", () => {
    const crypto = new SecretCrypto("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="); // 32 bytes
    const envelope = crypto.encrypt("wkr_abc", "super-secret-value");
    expect(envelope.startsWith("wp1:")).toBe(true);
    expect(crypto.decrypt("wkr_abc", envelope)).toBe("super-secret-value");
  });

  it("rejects keys of the wrong length", () => {
    expect(() => new SecretCrypto("dG9vLXNob3J0")).toThrow(/32 bytes/);
  });

  it("is isolated per worker: another worker key cannot decrypt", () => {
    const crypto = new SecretCrypto("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    const envelope = crypto.encrypt("wkr_a", "payload");
    expect(() => crypto.decrypt("wkr_b", envelope)).toThrow();
  });

  it("rejects tampered envelopes", () => {
    const crypto = new SecretCrypto("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    const envelope = crypto.encrypt("wkr_a", "payload");
    const [, iv, ct, tag] = envelope.split(":") as [string, string, string, string];
    const flipped = Buffer.from(ct, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => crypto.decrypt("wkr_a", `wp1:${iv}:${flipped.toString("base64")}:${tag}`)).toThrow();
  });

  it("reencrypts without changing the plaintext", () => {
    const crypto = new SecretCrypto("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    const e1 = crypto.encrypt("wkr_a", "same");
    const e2 = crypto.reencrypt("wkr_a", e1);
    expect(e2).not.toBe(e1);
    expect(crypto.decrypt("wkr_a", e2)).toBe("same");
  });
});

describe("SecretsBinding", () => {
  const crypto = new SecretCrypto("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

  it("loads and caches values on demand", async () => {
    const store = new Map<string, string>([
      ["wkr_x:TOKEN", crypto.encrypt("wkr_x", "tok123")],
    ]);
    let loads = 0;
    const binding = new SecretsBinding("wkr_x", crypto, async (_w, name) => {
      loads++;
      return store.get(`${_w}:${name}`);
    });

    expect(await binding.get("TOKEN")).toBe("tok123");
    expect(await binding.get("TOKEN")).toBe("tok123");
    expect(loads).toBe(1);
  });

  it("returns null for unknown secrets", async () => {
    const binding = new SecretsBinding("wkr_x", crypto, async () => undefined);
    expect(await binding.get("MISSING")).toBeNull();
  });

  it("invalidates cache on demand", async () => {
    const store = new Map<string, string>([
      ["wkr_x:TOKEN", crypto.encrypt("wkr_x", "v1")],
    ]);
    const binding = new SecretsBinding("wkr_x", crypto, async (_w, name) => store.get(`${_w}:${name}`));

    expect(await binding.get("TOKEN")).toBe("v1");
    store.set("wkr_x:TOKEN", crypto.encrypt("wkr_x", "v2"));
    expect(await binding.get("TOKEN")).toBe("v1"); // still cached
    binding.invalidate();
    expect(await binding.get("TOKEN")).toBe("v2");
  });
});
