import { NativeMath } from './nativeGlobals';

/** Deterministic 32-bit sfc32 generator seeded from the run options. */
export function createRandom32(seed: number): () => number {
  let a = seed >>> 0;
  let b = 0x9e3779b9;
  let c = 0x243f6a88;
  let d = 0xb7e15162;

  return function random32(): number {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function hashSeed(input: number | string): number {
  const text = String(input);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = NativeMath.imul(hash, 16777619);
  }
  return hash >>> 0;
}
