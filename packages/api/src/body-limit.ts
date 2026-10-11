import type { Context, Next } from "hono";
import { HttpError } from "./errors.js";

/** Default cap for request bodies accepted by the control plane. */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Reject requests whose declared Content-Length exceeds the cap. Streams
 * without a length are capped at read time via readBodyCapped().
 */
export function bodyLimitMiddleware(maxBytes: number = DEFAULT_MAX_BODY_BYTES) {
  return async (c: Context, next: Next) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `request body exceeds limit of ${maxBytes} bytes`
      );
    }
    await next();
  };
}

/**
 * Read a request body fully but abort with 413 once more than maxBytes has
 * arrived. Use instead of c.req.raw.arrayBuffer() for untrusted payloads
 * (chunked transfer can bypass a Content-Length check).
 */
export async function readBodyCapped(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new HttpError(
      413,
      "PAYLOAD_TOO_LARGE",
      `request body exceeds limit of ${maxBytes} bytes`
    );
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new HttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        `request body exceeds limit of ${maxBytes} bytes`
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
