#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".workers-platform.yaml");

interface CliConfig {
  apiUrl: string;
  apiKey: string;
}

function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error("Config not found. Run first: workers config:set <api-url> <api-key>");
    process.exit(1);
  }
  const lines = readFileSync(CONFIG_PATH, "utf8").split("\n");
  const get = (key: string) => lines.find((l) => l.startsWith(`${key}:`))?.split(":").slice(1).join(":").trim() ?? "";
  return { apiUrl: get("apiUrl").replace(/["']/g, ""), apiKey: get("apiKey").replace(/["']/g, "") };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const config = loadConfig();
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = (await response.json()) as { data?: T; error?: { message: string } };
  if (!response.ok) {
    console.error(`Error (${response.status}): ${json.error?.message ?? response.statusText}`);
    process.exit(1);
  }
  return json.data as T;
}

const program = new Command();
program.name("workers").description("CLI for the self-hosted Workers platform").version("0.1.0");

// --- config ---------------------------------------------------------------
const config = program.command("config").description("manage CLI configuration");
config
  .command("set")
  .argument("<api-url>", "control plane API URL")
  .argument("<api-key>", "API key (wpk_...)")
  .action((apiUrl: string, apiKey: string) => {
    writeFileSync(CONFIG_PATH, `apiUrl: "${apiUrl}"\napiKey: "${apiKey}"\n`, { mode: 0o600 });
    console.log(`Configuration saved to ${CONFIG_PATH}`);
  });

// --- worker ----------------------------------------------------------------
const worker = program.command("worker").description("manage workers");

worker
  .command("create")
  .argument("<name>", "worker name")
  .option("--cpu-ms <n>", "CPU limit in ms", "5000")
  .option("--memory-mb <n>", "memory limit in MB", "128")
  .action(async (name: string, opts: { cpuMs: string; memoryMb: string }) => {
    const created = await api<{ id: string }>("POST", "/api/workers", {
      name,
      limits: { cpu_ms: Number(opts.cpuMs), memory_mb: Number(opts.memoryMb) },
    });
    console.log(`Worker created: ${created.id}`);
  });

worker
  .command("deploy")
  .argument("<workerId>", "worker id")
  .argument("<file>", "path to worker source (ts/js)")
  .option("--manifest <json>", "manifest JSON string")
  .action(async (workerId: string, file: string, opts: { manifest?: string }) => {
    const source = readFileSync(file, "utf8");
    const config = loadConfig();
    const response = await fetch(`${config.apiUrl}/api/workers/${workerId}/versions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: source,
        manifest: opts.manifest ? JSON.parse(opts.manifest) : undefined,
      }),
    });
    const json = (await response.json()) as {
      data?: { version_id: string; bundle_size: number };
      error?: { message: string };
    };
    if (!response.ok) {
      console.error(`Deploy failed (${response.status}): ${json.error?.message}`);
      process.exit(1);
    }
    console.log(`Deployed version ${json.data?.version_id} (${json.data?.bundle_size} bytes)`);
  });

worker
  .command("logs")
  .argument("<workerId>", "worker id")
  .action(async (workerId: string) => {
    console.log(`Streaming logs for ${workerId} (SSE; Ctrl+C to stop)`);
    const cfg = loadConfig();
    const response = await fetch(`${cfg.apiUrl}/api/workers/${workerId}/logs`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "text/event-stream" },
    });
    const reader = response.body?.getReader();
    if (!reader) {
      console.error("failed to open log stream");
      process.exit(1);
    }
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stdout.write(decoder.decode(value));
    }
  });

worker
  .command("invoke")
  .argument("<workerId>", "worker id")
  .argument("[path]", "request path", "/")
  .option("-X, --method <method>", "HTTP method", "GET")
  .option("-b, --body <json>", "request body (JSON string)")
  .action(async (workerId: string, path: string, opts: { method: string; body?: string }) => {
    const result = await api<{ status: number; body: string; metrics: { wallMs: number } }>(
      "POST",
      `/api/workers/${workerId}/invoke`,
      { method: opts.method, path, body: opts.body }
    );
    console.log(`Status: ${result.status} (${result.metrics.wallMs}ms)`);
    console.log(result.body);
  });

worker
  .command("list")
  .action(async () => {
    const result = await api<Array<{ id: string; name: string; status: string }>>("GET", "/api/workers");
    for (const w of result ?? []) {
      console.log(`${w.id}  ${w.name}  [${w.status}]`);
    }
  });

worker
  .command("delete")
  .argument("<workerId>", "worker id")
  .action(async (workerId: string) => {
    await api("DELETE", `/api/workers/${workerId}`);
    console.log(`Worker ${workerId} deleted`);
  });

// --- secret ------------------------------------------------------------------
const secret = program.command("secret").description("manage worker secrets");
secret
  .command("put")
  .argument("<workerId>", "worker id")
  .argument("<name>", "secret name (UPPER_SNAKE)")
  .argument("<value>", "secret value")
  .action(async (workerId: string, name: string, value: string) => {
    await api("PUT", `/api/secrets?worker_id=${workerId}`, { [name]: value });
    console.log(`Secret ${name} saved`);
  });

secret
  .command("list")
  .argument("<workerId>", "worker id")
  .action(async (workerId: string) => {
    const result = await api<{ names: string[] }>("GET", `/api/secrets?worker_id=${workerId}`);
    for (const name of result.names) console.log(name);
  });

secret
  .command("delete")
  .argument("<workerId>", "worker id")
  .argument("<name>", "secret name")
  .action(async (workerId: string, name: string) => {
    await api("DELETE", `/api/secrets/${name}?worker_id=${workerId}`);
    console.log(`Secret ${name} deleted`);
  });

// --- d1 -----------------------------------------------------------------------
const d1 = program.command("d1").description("manage worker D1 databases");
d1
  .command("create")
  .argument("<workerId>", "worker id")
  .argument("<name>", "database name")
  .option("--schema <file>", "path to schema.sql to apply on create")
  .action(async (workerId: string, name: string, opts: { schema?: string }) => {
    const schemaSql = opts.schema ? readFileSync(opts.schema, "utf8") : undefined;
    const created = await api<{ id: string }>("POST", "/api/d1", {
      worker_id: workerId,
      name,
      schema_sql: schemaSql,
    });
    console.log(`D1 database created: ${created.id}`);
  });

d1
  .command("query")
  .argument("<workerId>", "worker id")
  .argument("<name>", "database name")
  .argument("<sql>", "SQL statement")
  .action(async (workerId: string, name: string, sql: string) => {
    const result = await api<{ results: unknown[] }>("POST", `/api/d1/${workerId}/${name}/query`, { sql });
    console.log(JSON.stringify(result.results, null, 2));
  });

d1
  .command("migrate")
  .argument("<workerId>", "worker id")
  .argument("<name>", "database name")
  .argument("<file>", "path to migrations file (one SQL statement per line)")
  .action(async (workerId: string, name: string, file: string) => {
    const statements = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("--"));
    const result = await api<{ applied: number }>("POST", `/api/d1/${workerId}/${name}/migrate`, { statements });
    console.log(`Applied ${result.applied} statements`);
  });

// --- kv -----------------------------------------------------------------------
const kv = program.command("kv").description("manage worker KV namespaces");
kv
  .command("create")
  .argument("<workerId>", "worker id")
  .argument("<name>", "namespace name")
  .action(async (workerId: string, name: string) => {
    await api("POST", "/api/kv", { worker_id: workerId, name });
    console.log(`KV namespace created: ${name}`);
  });

kv
  .command("keys")
  .argument("<workerId>", "worker id")
  .argument("<namespace>", "namespace name")
  .option("--prefix <prefix>", "key prefix filter")
  .action(async (workerId: string, namespace: string, opts: { prefix?: string }) => {
    const result = await api<{ keys: Array<{ name: string }> }>(
      "GET",
      `/api/kv/${workerId}/${namespace}/keys${opts.prefix ? `?prefix=${encodeURIComponent(opts.prefix)}` : ""}`
    );
    for (const k of result.keys) console.log(k.name);
  });

kv
  .command("bulk")
  .argument("<workerId>", "worker id")
  .argument("<namespace>", "namespace name")
  .argument("<file>", "path to bulk JSON file { put: [{key, value}], delete: [] }")
  .action(async (workerId: string, namespace: string, file: string) => {
    const payload = JSON.parse(readFileSync(file, "utf8"));
    const result = await api<{ put: number; deleted: number }>(
      "POST",
      `/api/kv/${workerId}/${namespace}/bulk`,
      payload
    );
    console.log(`Bulk: ${result.put} put, ${result.deleted} deleted`);
  });

// --- queue ----------------------------------------------------------------------
const queue = program.command("queue").description("manage worker queues");
queue
  .command("create")
  .argument("<workerId>", "worker id")
  .argument("<name>", "queue name")
  .option("--max-retries <n>", "max retries before DLQ", "3")
  .action(async (workerId: string, name: string, opts: { maxRetries: string }) => {
    await api("POST", "/api/queues", { worker_id: workerId, name, max_retries: Number(opts.maxRetries) });
    console.log(`Queue created: ${name}`);
  });

queue
  .command("push")
  .argument("<workerId>", "worker id")
  .argument("<queue>", "queue name")
  .argument("<message>", "message JSON string")
  .action(async (workerId: string, queueName: string, message: string) => {
    await api("POST", `/api/queues/${workerId}/${queueName}/messages`, { body: message });
    console.log("Message queued");
  });

queue
  .command("metrics")
  .argument("<workerId>", "worker id")
  .argument("<queue>", "queue name")
  .action(async (workerId: string, queueName: string) => {
    const result = await api<{ pending: number; deadLettered: number }>(
      "GET",
      `/api/queues/${workerId}/${queueName}/metrics`
    );
    console.log(`Pending: ${result.pending}, DLQ: ${result.deadLettered}`);
  });

// --- api-key ----------------------------------------------------------------------
const apiKey = program.command("api-key").description("manage platform API keys");
apiKey
  .command("create")
  .argument("<name>", "key name")
  .action(async (name: string) => {
    const result = await api<{ key: string; note: string }>("POST", "/api/api-keys", { name });
    console.log(`${result.key}\n${result.note}`);
  });

program.parse();
