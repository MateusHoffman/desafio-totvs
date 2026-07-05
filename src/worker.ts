import { queue, ordersDb, dlq, productsDb } from './db';
import { simulateErpOrderCreation } from './erp';
import { logger, metrics, span, metricsSnapshot, workerTraceCtx } from './observability';

let workerInterval: ReturnType<typeof setInterval> | null = null;
let metricsInterval: ReturnType<typeof setInterval> | null = null;
let processing = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Uma tentativa no ERP; registra latência (sucesso ou falha); true em sucesso.
const attemptErpOrder = async (orderId: string): Promise<boolean> => {
  const start = Date.now();
  try {
    await simulateErpOrderCreation(orderId);
    metrics.latencies.erp_order.push(Date.now() - start);
    return true;
  } catch {
    metrics.latencies.erp_order.push(Date.now() - start);
    return false;
  }
};

const reconcileDlq = async () => {
  if (queue.length > 0 || dlq.size === 0) return;

  const orderId = dlq.keys().next().value!;
  const trace = workerTraceCtx(ordersDb.get(orderId)?.correlationId);
  const start = Date.now();

  if (await attemptErpOrder(orderId)) {
    const order = ordersDb.get(orderId);
    if (order) order.status = 'SUCCESS';
    dlq.delete(orderId);
    metrics.checkout_reconciled++;
    span('worker_order', Date.now() - start, { ...trace, orderId, outcome: 'RECONCILED' });
    logger.info('DLQ reconciliado', { ...trace, orderId });
  }
  // falha: mantém na DLQ para próximo ciclo
};

// Processa um pedido: até 3 tentativas no ERP → SUCCESS, ou FAILED + DLQ.
const processOne = async (orderId: string) => {
  const order = ordersDb.get(orderId);
  const trace = workerTraceCtx(order?.correlationId);
  const itemStart = Date.now();

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await attemptErpOrder(orderId)) {
      if (order) order.status = 'SUCCESS';
      metrics.checkout_processed++;
      span('worker_order', Date.now() - itemStart, { ...trace, orderId, outcome: 'SUCCESS' });
      logger.info('Pedido faturado no ERP', { ...trace, orderId, attempts: attempt });
      return;
    }
    if (attempt < 3) await sleep(100 * 2 ** attempt);
  }

  if (order) order.status = 'FAILED';
  dlq.set(orderId, { orderId, error: 'Falha no ERP após 3 tentativas' });
  metrics.checkout_failed++;
  span('worker_order', Date.now() - itemStart, { ...trace, orderId, outcome: 'FAILED' });
  logger.error('Pedido enviado para DLQ', { ...trace, orderId });
};

export const startWorker = () => {
  if (workerInterval) return;

  // Poll ~2s. A guarda de reentrância impede ciclos concorrentes (setInterval
  // dispara independente do callback async anterior); drena toda a fila pendente
  // por ciclo para não segurar pedidos em backlog. Reconcilia 1 item da DLQ quando ociosa.
  workerInterval = setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      if (queue.length > 0) {
        while (queue.length > 0) await processOne(queue.shift()!);
      } else {
        await reconcileDlq();
      }
    } finally {
      processing = false;
    }
  }, 2000);

  metricsInterval = setInterval(() => {
    logger.info(
      'metrics_snapshot',
      metricsSnapshot({
        queueDepth: queue.length,
        dlqDepth: dlq.size,
        stockTotal: Array.from(productsDb.values()).reduce((acc, p) => acc + p.stock, 0),
      }),
    );
  }, 10000);
};

export const stopWorker = () => {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
};
