import type { RunRequest } from '../shared/types.js';
import type { WorkflowService } from './workflow-service.js';

/** Seed a handful of representative runs the UI opens with. */
export async function seedDemos(service: WorkflowService): Promise<void> {
  if (service.listRuns().length > 0) return;

  const happy: RunRequest = {
    workflowType: 'orderFulfillment',
    version: 'v1',
    input: { orderId: 'ORD-1001', amount: 19900, sku: 'SKU-A' },
    seed: 42,
    activities: {
      reserveInventory: { mode: 'succeed', afterMs: 80, result: { reserved: true } },
      chargePayment: { mode: 'succeed', afterMs: 150, result: { txId: 'TX-9001' } },
      notifyWarehouse: { mode: 'succeed', afterMs: 60, result: { notified: true } },
      sendConfirmation: { mode: 'succeed', afterMs: 40, result: { sent: true } },
    },
  };

  const compensating: RunRequest = {
    workflowType: 'orderFulfillment',
    version: 'v1',
    input: { orderId: 'ORD-1002', amount: 5200, sku: 'SKU-B' },
    seed: 7,
    activities: {
      reserveInventory: { mode: 'succeed', afterMs: 90, result: { reserved: true } },
      chargePayment: {
        mode: 'fail',
        afterMs: 120,
        error: { name: 'PaymentDeclined', message: '发卡行拒绝交易', nonRetriable: true },
      },
      notifyWarehouse: { mode: 'succeed', afterMs: 50 },
      releaseInventory: { mode: 'succeed', afterMs: 70, result: { released: true } },
      refundPayment: { mode: 'succeed' },
    },
  };

  const race: RunRequest = {
    workflowType: 'paymentRace',
    version: 'v1',
    input: { orderId: 'ORD-1003', amount: 3000 },
    seed: 99,
    activities: {
      flakyPayment: {
        mode: 'race',
        signals: [
          { kind: 'completed', atMs: 1000, result: { txId: 'TX-RACE' } },
          { kind: 'timeout', atMs: 1000 },
          { kind: 'cancelled', atMs: 1001 },
        ],
      },
    },
  };

  const nonDet: RunRequest = {
    workflowType: 'nonDeterministic',
    version: 'v1',
    input: { orderId: 'ORD-1004' },
    seed: 123,
    activities: {
      reserveInventory: { mode: 'succeed', afterMs: 30 },
      sendConfirmation: { mode: 'succeed', afterMs: 30 },
    },
  };

  await service.run(happy);
  await service.run(compensating);
  await service.run(race);
  await service.run(nonDet);
}
