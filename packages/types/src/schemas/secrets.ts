import { z } from "zod";

export const SECRET_VALUE_MAX_BYTES = 8 * 1024;
export const SECRETS_MAX_COUNT = 100;

export const secretsUpsertSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(SECRET_VALUE_MAX_BYTES))
  .refine((v) => Object.keys(v).length > 0, "at least one secret required")
  .refine((v) => Object.keys(v).length <= SECRETS_MAX_COUNT, `max ${SECRETS_MAX_COUNT} secrets`);
export type SecretsUpsert = z.infer<typeof secretsUpsertSchema>;
