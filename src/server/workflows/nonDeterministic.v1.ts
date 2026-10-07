import type { WorkflowContext } from '../runtime/registry.js';

interface OrderInput {
  orderId: string;
}

// 故意写坏的工作流：直接碰全局 Date/Math。
// 静态扫描会在注册时就报出来；运行/重放时只要分支真的执行到，也会被陷阱抓住。
export async function run(ctx: WorkflowContext, raw: unknown): Promise<unknown> {
  const input = raw as OrderInput;

  await ctx.activity('reserveInventory', { orderId: input.orderId });

  const startedAt = Date.now();
  const dice = Math.random();
  const stamp = new Date();

  await ctx.sleep(100);
  await ctx.activity('sendConfirmation', {
    orderId: input.orderId,
    startedAt,
    dice,
    stamp: stamp.toISOString(),
  });

  return { orderId: input.orderId, startedAt, dice };
}
