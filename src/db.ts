import { simulateErpFetch } from './erp';
import { logger, metrics, span, type TraceCtx } from './observability';

export type Product = { id: string; name: string; price: number; stock: number };
export type OrderStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
export type Order = {
  id: string;
  status: OrderStatus;
  correlationId: string;
  productId: string;
  quantity: number;
};

export const SEED_PRODUCTS: Product[] = [{ id: '123', name: 'Capinha A', price: 29.9, stock: 10 }];

export const productsDb = new Map<string, Product>(
  SEED_PRODUCTS.map((p) => [p.id, { ...p }]),
);

export const cache = new Map<string, { data: Product[]; expiresAt: number }>();

export const ordersDb = new Map<string, Order>();

export const queue: string[] = [];

export const dlq = new Map<string, { orderId: string; error: string }>();

export const idempotencyMap = new Map<string, string>();

const TTL = 5000;
let fetchPromise: Promise<Product[]> | null = null;

export type DebitResult = 'ok' | 'not_found' | 'insufficient';

// Espelha: UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?
export const tryDebitStock = (productId: string, quantity: number): DebitResult => {
  const product = productsDb.get(productId);
  if (!product) return 'not_found';
  if (product.stock < quantity) return 'insufficient';
  product.stock -= quantity;
  return 'ok';
};

type CheckoutInput = {
  idempotencyKey: string;
  productId: string;
  quantity: number;
  correlationId: string;
};

export type CheckoutResult =
  | { kind: 'replay'; orderId: string; status: string }
  | { kind: 'accepted'; orderId: string }
  | { kind: 'error'; message: string };

// Bloco síncrono: idempotência → débito → pedido → fila (sem await)
export const acceptCheckout = (input: CheckoutInput): CheckoutResult => {
  const existingOrderId = idempotencyMap.get(input.idempotencyKey);
  if (existingOrderId) {
    const existing = ordersDb.get(existingOrderId);
    return {
      kind: 'replay',
      orderId: existingOrderId,
      status: existing?.status ?? 'PENDING',
    };
  }

  const debit = tryDebitStock(input.productId, input.quantity);
  if (debit !== 'ok') {
    return {
      kind: 'error',
      message: debit === 'not_found' ? 'Produto não encontrado' : 'Estoque insuficiente',
    };
  }

  const orderId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  ordersDb.set(orderId, {
    id: orderId,
    status: 'PENDING',
    correlationId: input.correlationId,
    productId: input.productId,
    quantity: input.quantity,
  });
  idempotencyMap.set(input.idempotencyKey, orderId);
  cache.delete('products');
  queue.push(orderId);
  return { kind: 'accepted', orderId };
};

export type CatalogResult =
  | { ok: true; data: Product[] }
  | { ok: false; error: string };

export const getProductsCatalog = async (ctx: TraceCtx): Promise<CatalogResult> => {
  const start = Date.now();
  const cached = cache.get('products');

  if (cached && cached.expiresAt > Date.now()) {
    metrics.cache_hit++;
    logger.info('cache_hit', ctx);
    span('get_products', Date.now() - start, { ...ctx, cache: 'hit' });
    return { ok: true, data: cached.data };
  }

  metrics.cache_miss++;
  logger.info('cache_miss', ctx);

  if (!fetchPromise) {
    const erpStart = Date.now();
    fetchPromise = simulateErpFetch()
      .then((data) => {
        const erpDuration = Date.now() - erpStart;
        span('erp_fetch', erpDuration, { ...ctx, outcome: 'SUCCESS' });
        cache.set('products', { data, expiresAt: Date.now() + TTL });
        fetchPromise = null;
        return data;
      })
      .catch((err) => {
        span('erp_fetch', Date.now() - erpStart, { ...ctx, outcome: 'FAILED' });
        fetchPromise = null;
        throw err;
      });
  }

  try {
    const data = await fetchPromise;
    span('get_products', Date.now() - start, { ...ctx, cache: 'miss' });
    return { ok: true, data };
  } catch {
    if (cached) {
      logger.info('cache_stale_fallback', ctx);
      return { ok: true, data: cached.data };
    }
    return { ok: false, error: 'ERP indisponível' };
  }
};
