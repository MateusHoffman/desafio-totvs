import assert from 'node:assert';
import test from 'node:test';
import { app } from './app';
import {
  productsDb,
  cache,
  dlq,
  ordersDb,
  queue,
  idempotencyMap,
  SEED_PRODUCTS,
} from './db';
import { metrics, resetMetrics } from './observability';
import {
  resetErpBehavior,
  setErpFetchBehavior,
  setErpOrderBehavior,
  getErpFetchCallCount,
} from './erp';
import { startWorker, stopWorker } from './worker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resetState = () => {
  productsDb.clear();
  for (const p of SEED_PRODUCTS) productsDb.set(p.id, { ...p });
  cache.clear();
  ordersDb.clear();
  queue.length = 0;
  dlq.clear();
  idempotencyMap.clear();
  resetMetrics();
  resetErpBehavior();
};

const pollOrderStatus = async (
  baseUrl: string,
  orderId: string,
  expectedStatus: string,
  maxAttempts = 15,
) => {
  let status = 'PENDING';
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(500);
    const res = await fetch(`${baseUrl}/orders/${orderId}/status`);
    const body = (await res.json()) as { status: string };
    status = body.status;
    if (status === expectedStatus) return status;
  }
  return status;
};

test('CaseCellShop — problemas do desafio', async (t) => {
  resetState();
  setErpFetchBehavior('alwaysSucceed');
  startWorker();
  const server = app.listen(3001);
  const baseUrl = 'http://localhost:3001';

  // Problema 01 — Performance da vitrine (cache)
  await t.test('cache: miss na 1ª chamada e hit na 2ª', async () => {
    cache.delete('products');
    const missBefore = metrics.cache_miss;
    const hitBefore = metrics.cache_hit;

    const r1 = await fetch(`${baseUrl}/products`);
    const r2 = await fetch(`${baseUrl}/products`);

    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.ok(metrics.cache_miss >= missBefore + 1, 'cache_miss deveria aumentar na 1ª chamada');
    assert.ok(metrics.cache_hit >= hitBefore + 1, 'cache_hit deveria aumentar na 2ª chamada');
  });

  await t.test('cache: fallback stale quando ERP falha', async () => {
    setErpFetchBehavior('alwaysSucceed');
    await fetch(`${baseUrl}/products`);

    const stale = cache.get('products');
    assert.ok(stale);
    stale!.expiresAt = Date.now() - 1;

    setErpFetchBehavior('alwaysFail');
    const res = await fetch(`${baseUrl}/products`);

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as unknown[];
    assert.ok(Array.isArray(body) && body.length > 0);
    setErpFetchBehavior('alwaysSucceed');
  });

  await t.test('cache: ERP indisponível sem cache → 503', async () => {
    cache.delete('products');
    setErpFetchBehavior('alwaysFail');

    const res = await fetch(`${baseUrl}/products`);
    const body = (await res.json()) as { error: string };

    assert.strictEqual(res.status, 503);
    assert.strictEqual(body.error, 'ERP indisponível');
    setErpFetchBehavior('alwaysSucceed');
  });

  await t.test('cache: estoque reflete débito após checkout', async () => {
    cache.delete('products');
    setErpFetchBehavior('alwaysSucceed');
    await fetch(`${baseUrl}/products`);

    const stockBefore = productsDb.get('123')!.stock;
    await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': `cache-stock-${Date.now()}`,
      },
      body: JSON.stringify({ productId: '123', quantity: 2 }),
    });

    const productsRes = await fetch(`${baseUrl}/products`);
    const products = (await productsRes.json()) as { id: string; stock: number }[];
    const product = products.find((p) => p.id === '123');

    assert.strictEqual(productsRes.status, 200);
    assert.strictEqual(product?.stock, stockBefore - 2);
  });

  await t.test('cache: stampede — N misses concorrentes → 1 chamada ao ERP', async () => {
    cache.delete('products');
    setErpFetchBehavior('alwaysSucceed');
    const countBefore = getErpFetchCallCount();

    const responses = await Promise.all(
      Array.from({ length: 10 }).map(() => fetch(`${baseUrl}/products`)),
    );

    assert.ok(responses.every((r) => r.status === 200));
    assert.strictEqual(
      getErpFetchCallCount() - countBefore,
      1,
      'apenas 1 chamada ao ERP sob concorrência no miss',
    );
  });

  // Problema 02 — Consistência de estoque
  await t.test('estoque: payload inválido → 400', async () => {
    const res = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: '123' }),
    });

    assert.strictEqual(res.status, 400);
  });

  await t.test('estoque: concorrência bloqueia overselling', async () => {
    productsDb.set('999', { id: '999', name: 'Item', price: 15, stock: 1 });

    const requests = Array.from({ length: 10 }).map((_, i) =>
      fetch(`${baseUrl}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': `kc-${Date.now()}-${i}` },
        body: JSON.stringify({ productId: '999', quantity: 1 }),
      }),
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);

    assert.strictEqual(statuses.filter((s) => s === 202).length, 1, 'apenas 1 deve ser aceito');
    assert.strictEqual(statuses.filter((s) => s === 400).length, 9, '9 devem ser bloqueados');
    assert.strictEqual(productsDb.get('999')!.stock, 0, 'estoque nunca fica negativo');
  });

  await t.test('estoque: idempotência — replay devolve mesmo orderId', async () => {
    const stockBefore = productsDb.get('123')!.stock;
    const idempotencyKey = `replay-test-${Date.now()}`;
    const headers = {
      'Content-Type': 'application/json',
      'idempotency-key': idempotencyKey,
    };
    const body = JSON.stringify({ productId: '123', quantity: 1 });

    const r1 = await fetch(`${baseUrl}/checkout`, { method: 'POST', headers, body });
    const r2 = await fetch(`${baseUrl}/checkout`, { method: 'POST', headers, body });
    const j1 = (await r1.json()) as { orderId: string; status: string };
    const j2 = (await r2.json()) as { orderId: string; status: string };

    assert.strictEqual(r1.status, 202);
    assert.strictEqual(r2.status, 202);
    assert.strictEqual(j1.orderId, j2.orderId);
    assert.strictEqual(j1.status, j2.status);
    assert.strictEqual(productsDb.get('123')!.stock, stockBefore - 1);
  });

  // Problema 03 — Resiliência do checkout
  await t.test('checkout: worker evolui pedido para SUCCESS', async () => {
    setErpOrderBehavior('alwaysSucceed');

    const checkout = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': `worker-success-${Date.now()}`,
      },
      body: JSON.stringify({ productId: '123', quantity: 1 }),
    });
    const { orderId } = (await checkout.json()) as { orderId: string };

    const finalStatus = await pollOrderStatus(baseUrl, orderId, 'SUCCESS', 10);

    assert.strictEqual(finalStatus, 'SUCCESS');
    setErpOrderBehavior('default');
  });

  await t.test('checkout: falha no ERP → FAILED e DLQ', async () => {
    setErpOrderBehavior('alwaysFail');

    const checkout = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': `worker-fail-${Date.now()}`,
      },
      body: JSON.stringify({ productId: '123', quantity: 1 }),
    });
    const { orderId } = (await checkout.json()) as { orderId: string };

    const finalStatus = await pollOrderStatus(baseUrl, orderId, 'FAILED');

    assert.strictEqual(finalStatus, 'FAILED');
    assert.ok(dlq.has(orderId), 'pedido deve estar na DLQ após 3 tentativas');
    setErpOrderBehavior('default');
  });

  await t.test('checkout: reconciliação automática da DLQ', async () => {
    for (let i = 0; i < 30; i++) {
      if (queue.length === 0) break;
      await sleep(500);
    }
    dlq.clear();

    setErpOrderBehavior('alwaysFail');
    const checkout = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'idempotency-key': `dlq-reconcile-${Date.now()}`,
      },
      body: JSON.stringify({ productId: '123', quantity: 1 }),
    });
    const { orderId } = (await checkout.json()) as { orderId: string };

    await pollOrderStatus(baseUrl, orderId, 'FAILED', 20);
    assert.ok(dlq.has(orderId), 'pedido deve estar na DLQ antes da reconciliação');

    const reconciledBefore = metrics.checkout_reconciled;
    setErpOrderBehavior('alwaysSucceed');

    let reconciled = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (!dlq.has(orderId)) {
        const status = await pollOrderStatus(baseUrl, orderId, 'SUCCESS', 1);
        if (status === 'SUCCESS') reconciled = true;
        break;
      }
    }

    assert.ok(reconciled, 'worker deve reconciliar item da DLQ com ERP saudável');
    assert.ok(
      metrics.checkout_reconciled > reconciledBefore,
      'reconciliação deve incrementar checkout_reconciled',
    );
    setErpOrderBehavior('default');
  });

  stopWorker();
  server.close();
});
