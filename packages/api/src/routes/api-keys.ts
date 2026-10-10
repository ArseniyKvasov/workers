import { Hono } from "hono";
import type { ApiKeysRepository } from "@platform/catalog";
import { generateApiKey } from "../auth.js";
import { apiKeyCreateSchema } from "@platform/types";
import { badRequest } from "../errors.js";

/** API key management: create (returns the full key once), list, revoke. */
export function apiKeyRoutes(deps: { apiKeys: ApiKeysRepository }): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = apiKeyCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) throw badRequest("invalid api key payload", parsed.error.issues);

    const { key, prefix, hash } = generateApiKey();
    const record = await deps.apiKeys.create({ name: parsed.data.name, prefix, hash });
    if (!record) throw new Error("failed to create api key");

    // The full key is returned exactly once; only the hash is stored.
    return c.json(
      {
        data: {
          id: record.id,
          name: record.name,
          key,
          prefix,
          created_at: record.createdAt,
          note: "store this key securely; it will not be shown again",
        },
      },
      201
    );
  });

  app.get("/", async (c) => {
    const keys = await deps.apiKeys.list();
    return c.json({
      data: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        created_at: k.createdAt,
        last_used_at: k.lastUsedAt,
        revoked_at: k.revokedAt,
      })),
    });
  });

  app.post("/:id/revoke", async (c) => {
    const revoked = await deps.apiKeys.revoke(c.req.param("id"));
    return c.json({ data: { revoked } });
  });

  return app;
}
