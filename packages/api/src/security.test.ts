import { describe, expect, it } from "vitest";
import { readBodyCapped } from "./body-limit.js";
import { isTrustedProxy, parseTrustedProxies } from "./client-ip.js";

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/test", { method: "POST", body, headers });
}

describe("readBodyCapped", () => {
  it("reads bodies under the cap", async () => {
    const data = await readBodyCapped(makeRequest("hello"), 1024);
    expect(new TextDecoder().decode(data)).toBe("hello");
  });

  it("returns empty for bodiless requests", async () => {
    const req = new Request("http://localhost/", { method: "GET" });
    expect((await readBodyCapped(req, 1024)).byteLength).toBe(0);
  });

  it("rejects oversized Content-Length before reading", async () => {
    await expect(
      readBodyCapped(makeRequest("x", { "content-length": "9999" }), 1024)
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects chunked streams that exceed the cap mid-read", async () => {
    const big = "a".repeat(2048);
    await expect(readBodyCapped(makeRequest(big), 1024)).rejects.toMatchObject({ status: 413 });
  });
});

describe("parseTrustedProxies", () => {
  it("splits, trims and drops empties", () => {
    expect(parseTrustedProxies(" 127.0.0.1, ::1 ,,10.0.0.0/8 ")).toEqual([
      "127.0.0.1",
      "::1",
      "10.0.0.0/8",
    ]);
    expect(parseTrustedProxies(undefined)).toEqual([]);
  });
});

describe("isTrustedProxy", () => {
  it("matches exact IPs (IPv4 and IPv6)", () => {
    const proxies = ["127.0.0.1", "::1"];
    expect(isTrustedProxy("127.0.0.1", proxies)).toBe(true);
    expect(isTrustedProxy("::1", proxies)).toBe(true);
    expect(isTrustedProxy("8.8.8.8", proxies)).toBe(false);
  });

  it("normalizes IPv4-mapped IPv6 peers", () => {
    expect(isTrustedProxy("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
  });

  it("matches IPv4 CIDR ranges", () => {
    expect(isTrustedProxy("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(isTrustedProxy("192.168.1.50", ["192.168.1.0/24"])).toBe(true);
    expect(isTrustedProxy("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
    expect(isTrustedProxy("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
  });

  it("is strict when the list is empty", () => {
    expect(isTrustedProxy("127.0.0.1", [])).toBe(false);
  });
});
