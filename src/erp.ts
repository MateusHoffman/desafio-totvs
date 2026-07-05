import { productsDb, type Product } from './db';

type ErpBehavior = 'default' | 'alwaysSucceed' | 'alwaysFail';

let fetchBehavior: ErpBehavior = 'default';
let orderBehavior: ErpBehavior = 'default';
let erpFetchCallCount = 0;
const processedOrders = new Set<string>();

export const getErpFetchCallCount = () => erpFetchCallCount;

export const setErpFetchBehavior = (behavior: ErpBehavior) => {
  fetchBehavior = behavior;
};

export const setErpOrderBehavior = (behavior: ErpBehavior) => {
  orderBehavior = behavior;
};

export const resetErpBehavior = () => {
  fetchBehavior = 'default';
  orderBehavior = 'default';
  erpFetchCallCount = 0;
  processedOrders.clear();
};

export const simulateErpFetch = (): Promise<Product[]> =>
  new Promise((resolve, reject) => {
    erpFetchCallCount++;
    setTimeout(() => {
      if (fetchBehavior === 'alwaysFail') {
        reject(new Error('Falha simulada no ERP'));
        return;
      }
      if (fetchBehavior === 'alwaysSucceed' || Math.random() > 0.2) {
        resolve(Array.from(productsDb.values()));
        return;
      }
      reject(new Error('Falha simulada no ERP'));
    }, 200);
  });

export const simulateErpOrderCreation = (orderId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (processedOrders.has(orderId)) {
      resolve();
      return;
    }
    if (orderBehavior === 'alwaysFail') {
      reject(new Error('Falha simulada no ERP'));
      return;
    }
    if (orderBehavior === 'alwaysSucceed' || Math.random() > 0.2) {
      setTimeout(() => {
        processedOrders.add(orderId);
        resolve();
      }, 300);
      return;
    }
    reject(new Error('Falha simulada no ERP'));
  });
