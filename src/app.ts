import express from 'express';
import { acceptCheckout, getProductsCatalog, ordersDb } from './db';
import { correlationMiddleware, logger, span, traceCtx } from './observability';

export const app = express();
app.use(express.json());
app.use(correlationMiddleware);

app.get('/products', async (req, res) => {
  const result = await getProductsCatalog(traceCtx(req));
  if (!result.ok) return res.status(503).json({ error: result.error });
  return res.json(result.data);
});

app.post('/checkout', (req, res) => {
  const start = Date.now();
  const { productId, quantity } = req.body ?? {};
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const ctx = traceCtx(req);

  if (!productId || !idempotencyKey || !Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ error: 'Payload ou Idempotency-Key inválido' });
  }

  const result = acceptCheckout({
    idempotencyKey,
    productId,
    quantity,
    correlationId: ctx.correlationId!,
  });

  if (result.kind === 'replay') {
    span('post_checkout', Date.now() - start, {
      ...ctx,
      orderId: result.orderId,
      productId,
      replay: true,
      status: result.status,
    });
    logger.info('Checkout idempotente (replay)', {
      ...ctx,
      orderId: result.orderId,
      productId,
      status: result.status,
    });
    return res.status(202).json({ orderId: result.orderId, status: result.status });
  }
  if (result.kind === 'error') {
    return res.status(400).json({ error: result.message });
  }

  span('post_checkout', Date.now() - start, { ...ctx, orderId: result.orderId, productId });
  logger.info('Checkout aceito', { ...ctx, orderId: result.orderId, productId });
  return res.status(202).json({ orderId: result.orderId, status: 'PENDING' });
});

app.get('/orders/:orderId/status', (req, res) => {
  const start = Date.now();
  const ctx = traceCtx(req);
  const order = ordersDb.get(req.params.orderId);

  if (!order) {
    logger.info('Pedido não encontrado', { ...ctx, orderId: req.params.orderId });
    return res.status(404).json({ error: 'Pedido não encontrado' });
  }

  span('get_order_status', Date.now() - start, { ...ctx, orderId: order.id, status: order.status });
  logger.info('Status consultado', { ...ctx, orderId: order.id, status: order.status });
  return res.json({ id: order.id, status: order.status });
});
