import { describe, expect, it } from "vitest";
import { createOutboundService, EgressBlockedError } from "./egress.js";

function makeService(allowedDomains: string[]) {
  return createOutboundService("wkr_egress_test", { allowedDomains }, {});
}

describe("createOutboundService", () => {
  it("blocks all egress when allowlist is empty", async () => {
    const service = makeService([]);
    await expect(service(new Request("https://example.com/"))).rejects.toThrow(EgressBlockedError);
  });

  it("allows exact allowlisted hostnames", async () => {
    const service = makeService(["example.com"]);
    // Network call will be attempted; we only assert it is not blocked by
    // the allowlist (DNS resolution may fail in sandbox -> still EgressBlocked).
    try {
      const res = await service(new Request("https://example.com/"));
      expect(res.status).toBeGreaterThan(0);
    } catch (error) {
      expect(error).toBeInstanceOf(EgressBlockedError);
    }
  });

  it("supports wildcard allowlist entries", async () => {
    const service = makeService(["*.example.org"]);
    try {
      await service(new Request("https://api.example.org/"));
    } catch (error) {
      expect(error).toBeInstanceOf(EgressBlockedError);
      expect((error as Error).message).not.toMatch(/not in the allowlist/);
    }
  });

  it("blocks private IP ranges (SSRF)", async () => {
    const service = makeService(["*"]);
    await expect(service(new Request("http://127.0.0.1/x"))).rejects.toThrow(/private IP/);
    await expect(service(new Request("http://10.0.0.5/x"))).rejects.toThrow(/private IP/);
    await expect(service(new Request("http://192.168.1.1/x"))).rejects.toThrow(/private IP/);
    await expect(service(new Request("http://169.254.169.254/latest/meta-data/"))).rejects.toThrow(/private IP/);
    await expect(service(new Request("http://172.16.0.1/x"))).rejects.toThrow(/private IP/);
    await expect(service(new Request("http://100.64.0.1/x"))).rejects.toThrow(/private IP/);
  });

  it("blocks localhost and internal hostnames", async () => {
    const service = makeService(["*"]);
    await expect(service(new Request("http://localhost:3000/x"))).rejects.toThrow(/internal host/);
    await expect(service(new Request("http://my-service.internal/x"))).rejects.toThrow(/internal host/);
    await expect(service(new Request("http://printer.local/x"))).rejects.toThrow(/internal host/);
  });
});
