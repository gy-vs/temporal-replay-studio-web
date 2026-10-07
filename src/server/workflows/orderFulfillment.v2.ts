import type { WorkflowContext } from '../runtime/registry.js';

interface OrderInput {
  orderId: string;
  amount: number;
  sku: string;
}

// 订单履约 v2：用显式版本标记引入风控预检（新分支）。
// 带着旧标记（版本 0）的历史重放时会自动走回旧分支，不算分歧。
export async function run(ctx: WorkflowContext, raw: unknown): Promise<unknown> {
  const input = raw as OrderInput;

  const riskVersion = ctx.version('risk-precheck', 1);

  if (riskVersion >= 1) {
    const risk = await ctx.activity('riskPrecheck', { orderId: input.orderId, amount: input.amount });
    if ((risk as { rejected?: boolean }).rejected) {
      ctx.failWorkflow('风控拒绝该订单', { name: 'RiskRejected', nonRetriable: true });
    }
  }

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
