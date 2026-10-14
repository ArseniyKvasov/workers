import { Hono } from "hono";
import type { SecretsRepository } from "@platform/catalog";
import type { WorkersService } from "../services/workers-service.js";
import type { SecretCrypto } from "@platform/bindings";
import { badRequest, notFound } from "../errors.js";
import { secretsUpsertSchema } from "@platform/types";

export function secretsRoutes(deps: {
  workersService: WorkersService;
  secretsRepo: SecretsRepository;
  secretCrypto: SecretCrypto;
}): Hono {
  const app = new Hono();

  app.put("/secrets", async (c) => {
    const body = (await c.req.json()) as Record<string, string>;
    const workerId = c.req.query("worker_id") ?? (c.req.header("x-worker-id") ?? "");
    if (!workerId) throw badRequest("worker_id query parameter is required");
    await deps.workersService.getWorker(workerId);

    const parsed = secretsUpsertSchema.safeParse(body);
    if (!parsed.success) throw badRequest("invalid secrets payload", parsed.error.issues);

    const values = Object.entries(parsed.data).map(([name, value]) => ({
      name,
      encryptedValue: deps.secretCrypto.encrypt(workerId, value),
    }));
    const updated = await deps.secretsRepo.upsertMany(workerId, values);
    await deps.workersService.reloadPromoted(workerId);
    return c.json({ data: { updated } });
  });

  app.get("/secrets", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");
    await deps.workersService.getWorker(workerId);
    const names = await deps.secretsRepo.listNames(workerId);
    return c.json({ data: { names } });
  });

  app.delete("/secrets/:name", async (c) => {
    const workerId = c.req.query("worker_id");
    if (!workerId) throw badRequest("worker_id query parameter is required");
    await deps.workersService.getWorker(workerId);
    const deleted = await deps.secretsRepo.delete(workerId, c.req.param("name"));
    if (!deleted) throw notFound("secret", c.req.param("name"));
    await deps.workersService.reloadPromoted(workerId);
    return c.json({ data: { deleted: true } });
  });

  return app;
}
