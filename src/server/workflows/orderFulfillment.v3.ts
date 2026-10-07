import type { WorkflowContext } from '../runtime/registry.js';

interface OrderInput {
  orderId: string;
  amount: number;
  sku: string;
}

// 订单履约 v3：直接重排了命令（扣款前先通知仓配，且未使用版本标记）。
// 用来演示"新代码接手旧历史后做出不一样的决定"——重放应在第一个分歧点停下。
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

  // 先通知仓配再扣款（v1 是并行）——历史重放到这里会产生命令分歧。
  await ctx.activity('notifyWarehouse', { orderId: input.orderId });
  const chargeResult = await ctx.activity('chargePayment', { orderId: input.orderId, amount: input.amount }, {
    scheduleToCloseTimeoutMs: 3000,
    retry: { maxAttempts: 2, initialBackoffMs: 200, maxBackoffMs: 800 },
  });
  ctx.registerCompensation('退款', {
    activityType: 'refundPayment',
    input: { orderId: input.orderId, amount: input.amount },
    options: { retry: { maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 400 } },
  });

  await ctx.activity('sendConfirmation', { orderId: input.orderId, txId: (chargeResult as { txId?: string }).txId ?? null });

  return { orderId: input.orderId, fulfilled: true, at: ctx.now() };
}
