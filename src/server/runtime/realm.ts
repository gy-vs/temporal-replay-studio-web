import vm from 'node:vm';
import ts from 'typescript';

export interface RealmTraps {
  /** Called when workflow code evaluates Date.now() or new Date() with no args. */
  onNow(kind: 'Date.now' | 'new Date()'): number;
  /** Called when workflow code evaluates Math.random(). */
  onRandom(): number;
}

export interface CompiledModule {
  exports: Record<string, unknown>;
}

/**
 * Compiles a self-contained TypeScript module (imports other than the runtime
 * DSL are unsupported on purpose — workflows must stay pure) and evaluates it
 * in an isolated realm where Date and Math are trapped.
 */
export function compileWorkflowModule(source: string, fileName: string, traps: RealmTraps): CompiledModule {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      sourceMap: false,
      inlineSourceMap: false,
    },
    fileName,
  });

  const sandbox: Record<string, unknown> = {
    __trapOnNow: (kind: 'Date.now' | 'new Date()') => traps.onNow(kind),
    __trapOnRandom: () => traps.onRandom(),
  };
  vm.createContext(sandbox);

  // Build trapped Date inside the realm so `instanceof` stays consistent.
  // The host trap functions are only *called* later (closures resolve the
  // globals at call time), so having them on the sandbox up front is enough.
  vm.runInContext(
    `
    const __RealDate = Date;
    function TrappedDate(...args) {
      if (new.target) {
        if (args.length === 0) return new __RealDate(__trapOnNow('new Date()'));
        return new __RealDate(...args);
      }
      if (args.length === 0) return __RealDate(__trapOnNow('new Date()')).toString();
      return __RealDate(...args).toString();
    }
    TrappedDate.prototype = __RealDate.prototype;
    TrappedDate.now = function () { return __trapOnNow('Date.now'); };
    TrappedDate.parse = __RealDate.parse.bind(__RealDate);
    TrappedDate.UTC = __RealDate.UTC.bind(__RealDate);
    globalThis.Date = TrappedDate;

    const TrappedMath = Object.create(Math);
    TrappedMath.random = function () { return __trapOnRandom(); };
    globalThis.Math = TrappedMath;
    `,
    sandbox,
  );

  // Workflows must get time through the DSL — real timers are nondeterministic.
  const forbidden = (name: string) => () => {
    throw new Error(
      `${name} 在工作流代码中被禁止：重放时无法重现。请改用 ctx.sleep() 等运行时接口。`,
    );
  };
  sandbox.setTimeout = forbidden('setTimeout');
  sandbox.setInterval = forbidden('setInterval');
  sandbox.setImmediate = forbidden('setImmediate');
  sandbox.queueMicrotask = (cb: () => void) => Promise.resolve().then(cb);

  const moduleObj = { exports: {} as Record<string, unknown> };
  sandbox.module = moduleObj;
  sandbox.exports = moduleObj.exports;
  sandbox.require = (spec: string) => {
    throw new Error(`工作流不允许 import/require 外部模块（"${spec}"）；只使用 ctx 提供的 DSL`);
  };
  sandbox.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${transpiled.outputText}\n})`;
  const fn = vm.runInContext(wrapped, sandbox, { filename: fileName });
  fn(moduleObj.exports, sandbox.require, moduleObj, fileName, '/');

  // Workflow code may reassign module.exports; CommonJS exposes it through the
  // same object reference we passed in.
  const exported = moduleObj.exports as Record<string, unknown>;
  return { exports: exported };
}
