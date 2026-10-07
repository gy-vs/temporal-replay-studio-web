// Capture runtime globals before server-wide determinism proxies are installed.
// User workflow code must use WorkflowContext; server internals may use these
// saved references for IDs, wall-clock response timestamps, and PRNG arithmetic.
export const NativeDate = Date;
export const NativeMath = Math;
