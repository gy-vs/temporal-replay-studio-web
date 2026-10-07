import type { WorkflowContext } from '../runtime/registry.js';

// 同一个支付活动的完成、超时、取消几乎同时到达：
// 历史里第一个到达的终态算数，其余的丢弃并记录。
export async function run(ctx: WorkflowContext, raw: unknown): Promise<unknown> {
  const input = raw as { orderId: string; amount: number };
  const result = await ctx.activity('flakyPayment', input, {
    scheduleToCloseTimeoutMs: 1000,
    retry: { maxAttempts: 1, initialBackoffMs: 100, maxBackoffMs: 500 },
  });
  return { paid: true, result };
}
