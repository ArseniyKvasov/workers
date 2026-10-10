import { Counter, Gauge, Histogram, collectDefaultMetrics, Registry } from "prom-client";

/** Label names shared across the metrics registry. */
const WORKER_LABEL = "worker_id";
const STATUS_LABEL = "status";
const TYPE_LABEL = "type";

export class MetricsRegistry {
  readonly registry: Registry;

  readonly requestsTotal: Counter<string>;
  readonly requestDuration: Histogram<string>;
  readonly errorsTotal: Counter<string>;
  readonly isolatesActive: Gauge<string>;
  readonly cpuMsTotal: Counter<string>;
  readonly egressBytesTotal: Counter<string>;
  readonly d1RowsRead: Counter<string>;
  readonly d1RowsWritten: Counter<string>;
  readonly kvOpsTotal: Counter<string>;
  readonly queueMessagesTotal: Counter<string>;
  readonly secretsOpsTotal: Counter<string>;
  readonly limitExceededTotal: Counter<string>;
  readonly apiRequestsTotal: Counter<string>;
  readonly apiRequestDuration: Histogram<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry, prefix: "platform_" });

    this.requestsTotal = new Counter({
      name: "platform_worker_requests_total",
      help: "Total requests handled by worker isolates",
      labelNames: [WORKER_LABEL, STATUS_LABEL],
      registers: [this.registry],
    });

    this.requestDuration = new Histogram({
      name: "platform_worker_request_duration_seconds",
      help: "Worker isolate request duration",
      labelNames: [WORKER_LABEL],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
      registers: [this.registry],
    });

    this.errorsTotal = new Counter({
      name: "platform_worker_errors_total",
      help: "Errors thrown inside worker isolates",
      labelNames: [WORKER_LABEL, TYPE_LABEL],
      registers: [this.registry],
    });

    this.isolatesActive = new Gauge({
      name: "platform_isolates_active",
      help: "Currently active worker isolates",
      registers: [this.registry],
    });

    this.cpuMsTotal = new Counter({
      name: "platform_worker_cpu_ms_total",
      help: "CPU time consumed by worker isolates (milliseconds)",
      labelNames: [WORKER_LABEL],
      registers: [this.registry],
    });

    this.egressBytesTotal = new Counter({
      name: "platform_worker_egress_bytes_total",
      help: "Outbound bytes metered from worker egress fetches",
      labelNames: [WORKER_LABEL],
      registers: [this.registry],
    });

    this.d1RowsRead = new Counter({
      name: "platform_worker_d1_rows_read_total",
      help: "Rows read via D1 bindings",
      labelNames: [WORKER_LABEL],
      registers: [this.registry],
    });

    this.d1RowsWritten = new Counter({
      name: "platform_worker_d1_rows_written_total",
      help: "Rows written via D1 bindings",
      labelNames: [WORKER_LABEL],
      registers: [this.registry],
    });

    this.kvOpsTotal = new Counter({
      name: "platform_worker_kv_ops_total",
      help: "Operations performed via KV bindings",
      labelNames: [WORKER_LABEL, TYPE_LABEL],
      registers: [this.registry],
    });

    this.queueMessagesTotal = new Counter({
      name: "platform_worker_queue_messages_total",
      help: "Messages sent via Queue bindings",
      labelNames: [WORKER_LABEL],
      registers: [this.registry],
    });

    this.secretsOpsTotal = new Counter({
      name: "platform_worker_secrets_ops_total",
      help: "Operations performed via Secrets bindings",
      labelNames: [WORKER_LABEL, TYPE_LABEL],
      registers: [this.registry],
    });

    this.limitExceededTotal = new Counter({
      name: "platform_worker_limit_exceeded_total",
      help: "Resource limit violations observed in worker isolates",
      labelNames: [WORKER_LABEL, TYPE_LABEL],
      registers: [this.registry],
    });

    this.apiRequestsTotal = new Counter({
      name: "platform_api_requests_total",
      help: "Control plane API requests",
      labelNames: ["route", "method", STATUS_LABEL],
      registers: [this.registry],
    });

    this.apiRequestDuration = new Histogram({
      name: "platform_api_request_duration_seconds",
      help: "Control plane API request duration",
      labelNames: ["route", "method"],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
  }

  /** Render the registry in Prometheus text exposition format. */
  async serve(): Promise<string> {
    return this.registry.metrics();
  }
}

let singleton: MetricsRegistry | undefined;

export function getMetrics(): MetricsRegistry {
  singleton ??= new MetricsRegistry();
  return singleton;
}
