import { hkdfSync, createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secret encryption: master key from the environment, per-worker keys derived
 * with HKDF-SHA256, values sealed with AES-256-GCM (authenticated).
 *
 * Wire format: wp1:<iv-b64>:<ciphertext-b64>:<tag-b64>
 * (The version prefix allows transparent re-encryption on key rotation.)
 */
export class SecretCrypto {
  constructor(private readonly masterKeyB64: string) {
    const key = Buffer.from(masterKeyB64, "base64");
    if (key.length !== 32) {
      throw new Error(
        `SECRETS_MASTER_KEY must decode to 32 bytes (got ${key.length}); generate one with: openssl rand -base64 32`
      );
    }
  }

  private workerKey(workerId: string): Buffer {
    const salt = createHash("sha256").update(`wp-secret-salt:${workerId}`).digest();
    return Buffer.from(
      hkdfSync("sha256", Buffer.from(this.masterKeyB64, "base64"), salt, Buffer.from("worker-secrets"), 32)
    );
  }

  encrypt(workerId: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.workerKey(workerId), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `wp1:${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
  }

  decrypt(workerId: string, envelope: string): string {
    const parts = envelope.split(":");
    if (parts.length !== 4 || parts[0] !== "wp1") {
      throw new Error("malformed secret envelope");
    }
    const [, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
    const decipher = createDecipheriv("aes-256-gcm", this.workerKey(workerId), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  }

  /** Re-encrypt every secret under fresh HKDF randomness (used on rotation). */
  reencrypt(workerId: string, envelope: string): string {
    return this.encrypt(workerId, this.decrypt(workerId, envelope));
  }
}

/** Exposes secrets to worker isolates via env.SECRETS.get(name). */
export class SecretsBinding {
  private cache = new Map<string, string>();

  constructor(
    private readonly workerId: string,
    private readonly crypto: SecretCrypto,
    private readonly loader: (workerId: string, name: string) => Promise<string | undefined>,
    private readonly hooks: { onOp?: (workerId: string, op: string) => void } = {}
  ) {}

  /** Fetch a secret value on demand; values are never enumerable from the isolate. */
  async get(name: string): Promise<string | null> {
    this.hooks.onOp?.(this.workerId, "get");
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    const envelope = await this.loader(this.workerId, name);
    if (envelope === undefined) return null;

    const value = this.crypto.decrypt(this.workerId, envelope);
    this.cache.set(name, value);
    return value;
  }

  /** Drop cached values (called when secrets change or on hot reload). */
  invalidate(): void {
    this.cache.clear();
  }
}
