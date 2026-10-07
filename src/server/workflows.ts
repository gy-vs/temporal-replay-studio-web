import type { WorkflowDefinition } from '../shared/types';
import { ActivitySimulator } from './activitySimulator';

const reserveInventory: WorkflowDefinition['handler'] = async (input, ctx) => {
  const orderId = String((input as { orderId?: string }).orderId ?? 'order-1');
  ctx.registerCompensation('release-inventory-reservation', async (comp) => {
    await comp.activity('releaseInventory', { orderId });
  });
  await ctx.activity('reserveInventory', { orderId });
};

export const orderFulfillmentV1: WorkflowDefinition = {
  workflowType: 'orderFulfillment',
  version: 'v1',
  description: '基线：预留库存、扣款、发货，随后发收据。',
  handler: async (input, ctx) => {
    const order = input as { orderId?: string; amount?: number };
    const orderId = order.orderId ?? 'order-1';
    const amount = order.amount ?? 4200;

    // The old deployment already recorded an explicit marker, but its supported
    // window stopped at version one. v2 widens the window and follows the old
    // branch when it encounters the historical value one.
    const version = ctx.getVersion('order-fulfillment-parallel-carrier', 1, 1);

    ctx.registerCompensation('release-inventory-reservation', async (comp) => {
      await comp.activity('releaseInventory', { orderId });
    });
    ctx.registerCompensation('refund-payment', async (comp) => {
      await comp.activity('refundPayment', { orderId, amount });
    });

    await ctx.activity('reserveInventory', { orderId });
    await ctx.activity('chargePayment', { orderId, amount }, { startToCloseTimeoutMs: 5000 });

    await ctx.timer(500);
    const shipmentId = await ctx.activity('shipOrder', { orderId }, {
      startToCloseTimeoutMs: 5_000,
    });
    await ctx.activity('sendReceipt', { orderId, shipmentId });

    return { status: 'fulfilled', orderId, shipmentId, version, generatedFrom: 'v1' };
  },
};

export const orderFulfillmentV2: WorkflowDefinition = {
  workflowType: 'orderFulfillment',
  version: 'v2',
  description: '新代码：显式版本标记；旧历史继续 v1 收据分支，新运行增加并行物流准备。',
  handler: async (input, ctx) => {
    const order = input as { orderId?: string; amount?: number };
    const orderId = order.orderId ?? 'order-1';
    const amount = order.amount ?? 4200;

    const version = ctx.getVersion('order-fulfillment-parallel-carrier', 1, 2);

    ctx.registerCompensation('release-inventory-reservation', async (comp) => {
      await comp.activity('releaseInventory', { orderId });
    });
    ctx.registerCompensation('refund-payment', async (comp) => {
      await comp.activity('refundPayment', { orderId, amount });
    });

    await ctx.activity('reserveInventory', { orderId });
    await ctx.activity('chargePayment', { orderId, amount }, { startToCloseTimeoutMs: 5000 });

    await ctx.timer(500);

    if (version >= 2) {
      const [packingId, carrierId] = await Promise.all([
        ctx.activity('preparePacking', { orderId }),
        ctx.activity('notifyCarrier', { orderId }),
      ]);
      const shipmentId = await ctx.activity('shipOrder', {
        orderId,
        packingId,
        carrierId,
      });
      await ctx.activity('sendReceipt', { orderId, shipmentId });
      return { status: 'fulfilled', orderId, shipmentId, version, generatedFrom: 'v2' };
    }

    const shipmentId = await ctx.activity('shipOrder', { orderId }, {
      startToCloseTimeoutMs: 5_000,
    });
    await ctx.activity('sendReceipt', { orderId, shipmentId });
    return { status: 'fulfilled', orderId, shipmentId, version, generatedFrom: 'v1' };
  },
};

export const nondeterministicWorkflowV1: WorkflowDefinition = {
  workflowType: 'nondeterministicDemo',
  version: 'v1',
  description: '故意直接调用 Math.random，用于验证运行和重放都能拦截。',
  handler: async (input, ctx) => {
    await ctx.activity('reserveInventory', input);
    return { value: Math.random() };
  },
};

export const allWorkflowDefinitions: WorkflowDefinition[] = [
  orderFulfillmentV1,
  orderFulfillmentV2,
  nondeterministicWorkflowV1,
];

export function createDefaultSimulator(): ActivitySimulator {
  return new ActivitySimulator([
    { name: 'reserveInventory', behavior: 'success', delayMs: 100 },
    { name: 'releaseInventory', behavior: 'success', delayMs: 50 },
    { name: 'chargePayment', behavior: 'success', delayMs: 150 },
    { name: 'refundPayment', behavior: 'success', delayMs: 80 },
    { name: 'shipOrder', behavior: 'success', delayMs: 300 },
    { name: 'sendReceipt', behavior: 'success', delayMs: 70 },
    { name: 'preparePacking', behavior: 'success', delayMs: 120 },
    { name: 'notifyCarrier', behavior: 'success', delayMs: 120 },
  ]);
}

export { reserveInventory };
