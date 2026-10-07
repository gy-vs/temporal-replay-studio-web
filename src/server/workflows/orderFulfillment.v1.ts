import type { WorkflowContext } from '../runtime/registry.js';

interface OrderInput {
  orderId: string;
  amount: number;
  sku: string;
}

// 订单履约 v1：锁库存 -> (扣款 || 通知仓配 并行) -> 确认。
// 任何一步失败，已登记的补偿按相反顺序执行。
export async function run(ctx: WorkflowContext, raw: unknown): Promise<unknown> {
  const input = raw as OrderInput;

  await ctx.activity('reserveInventory', { orderId: input.orderId, sku: input.sku }, {
    scheduleToCloseTimeoutMs: 2000,
    retry: { maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 500 },
  });
  ctx.registerCompensation('释放库存', {
    activityType: 'releaseInventory',
    input: { orderId: input.orderId, sku: input.sku },
  });

  const [chargeResult] = await ctx.parallel([
    () => ctx.activity('chargePayment', { orderId: input.orderId, amount: input.amount }, {
      scheduleToCloseTimeoutMs: 3000,
      retry: { maxAttempts: 2, initialBackoffMs: 200, maxBackoffMs: 800 },
    }),
    () => ctx.activity('notifyWarehouse', { orderId: input.orderId }),
  ]);
  ctx.registerCompensation('退款', {
    activityType: 'refundPayment',
    input: { orderId: input.orderId, amount: input.amount },
    options: { retry: { maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 400 } },
  });

  await ctx.activity('sendConfirmation', { orderId: input.orderId, txId: (chargeResult as { txId?: string }).txId ?? null });

  return { orderId: input.orderId, fulfilled: true, at: ctx.now() };
}
