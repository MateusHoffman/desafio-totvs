import { randomUUID } from 'crypto';

type LogData = Record<string, unknown>;

export const metrics = {
  cache_hit: 0,
  cache_miss: 0,
  checkout_processed: 0,
  checkout_failed: 0,
  checkout_reconciled: 0,
  latencies: {
    get_products: [] as number[],
    post_checkout: [] as number[],
    worker_order: [] as number[],
    get_order_status: [] as number[],
    erp_fetch: [] as number[],
    erp_order: [] as number[],
  },
};

export const logger = {
  info: (msg: string, data: LogData = {}) =>
    console.log(
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', msg, ...data }),
    ),
  error: (msg: string, data: LogData = {}) =>
    console.error(
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', msg, ...data }),
    ),
};

export type TraceCtx = {
  correlationId?: string;
  requestId?: string;
  [key: string]: unknown;
};

export const span = (name: string, durationMs: number, ctx: TraceCtx = {}) => {
  const { correlationId, requestId, traceId, ...rest } = ctx;
  const resolvedTraceId = (traceId as string | undefined) ?? correlationId;
  const bucket = metrics.latencies[name as keyof typeof metrics.latencies];
  if (bucket) bucket.push(durationMs);

  logger.info('span', {
    span: name,
    span_duration_ms: durationMs,
    trace_type: 'stub',
    correlationId,
    requestId,
    ...(resolvedTraceId ? { traceId: resolvedTraceId } : {}),
    ...rest,
  });
};

export const correlationMiddleware = (req: any, res: any, next: any) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
  const requestId = randomUUID();
  req.headers['x-correlation-id'] = correlationId;
  req.correlationId = correlationId;
  req.requestId = requestId;
  res.setHeader('x-correlation-id', correlationId);
  res.setHeader('x-request-id', requestId);
  next();
};

export const traceCtx = (req: {
  correlationId?: string;
  requestId?: string;
  headers: Record<string, unknown>;
}) => {
  const correlationId = (req.correlationId ?? req.headers['x-correlation-id']) as
    | string
    | undefined;
  return {
    correlationId,
    requestId: req.requestId,
    ...(correlationId ? { traceId: correlationId } : {}),
  };
};

export const workerTraceCtx = (correlationId?: string) => ({
  correlationId,
  traceId: correlationId,
  parentSpan: 'post_checkout',
  parentTraceId: correlationId,
});

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
};

const hist = (values: number[]) => ({
  count: values.length,
  avg_ms: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0,
  p95_ms: percentile(values, 95),
});

export const metricsSnapshot = (state?: {
  queueDepth: number;
  dlqDepth: number;
  stockTotal: number;
}) => ({
  cache_hit: metrics.cache_hit,
  cache_miss: metrics.cache_miss,
  checkout_processed: metrics.checkout_processed,
  checkout_failed: metrics.checkout_failed,
  checkout_reconciled: metrics.checkout_reconciled,
  queue_depth: state?.queueDepth ?? 0,
  dlq_depth: state?.dlqDepth ?? 0,
  stock_total: state?.stockTotal ?? 0,
  erp_fetch_latency: hist(metrics.latencies.erp_fetch),
  erp_order_latency: hist(metrics.latencies.erp_order),
  latencies: Object.fromEntries(
    Object.entries(metrics.latencies).map(([k, v]) => [k, hist(v)]),
  ),
});

export const resetMetrics = () => {
  metrics.cache_hit = 0;
  metrics.cache_miss = 0;
  metrics.checkout_processed = 0;
  metrics.checkout_failed = 0;
  metrics.checkout_reconciled = 0;
  for (const key of Object.keys(metrics.latencies) as (keyof typeof metrics.latencies)[]) {
    metrics.latencies[key].length = 0;
  }
};
