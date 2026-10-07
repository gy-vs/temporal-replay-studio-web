import ts from 'typescript';

export interface DeterminismFinding {
  kind: 'Date.now' | 'new Date()' | 'Math.random';
  message: string;
  line: number;
  column: number;
}

interface Scope {
  /** names bound with var/function/params (function-scoped) */
  fnScoped: Set<string>;
  /** names bound with let/const/class/import (block-scoped) */
  blockScoped: Set<string>;
  kind: 'function' | 'block' | 'module';
}

/**
 * Statically find direct uses of Date.now(), `new Date()` (no args) and
 * Math.random() that resolve against the globals (i.e. are not shadowed by a
 * local binding). Catches branches that a single run never executes.
 */
export function scanForNonDeterminism(source: string, fileName = 'workflow.ts'): DeterminismFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const findings: DeterminismFinding[] = [];

  const moduleScope: Scope = { fnScoped: new Set(), blockScoped: new Set(), kind: 'module' };
  const stack: Scope[] = [moduleScope];
  const current = () => stack[stack.length - 1];

  function isBound(name: string): boolean {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].fnScoped.has(name) || stack[i].blockScoped.has(name)) return true;
    }
    return false;
  }

  function lineCol(node: ts.Node) {
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { line: p.line + 1, column: p.character + 1 };
  }

  function addFinding(kind: DeterminismFinding['kind'], node: ts.Node) {
    const { line, column } = lineCol(node);
    const messages: Record<DeterminismFinding['kind'], string> = {
      'Date.now': `第 ${line} 行直接调用 Date.now()，重放时无法得到同一个时间；请改用 ctx.now()`,
      'new Date()': `第 ${line} 行直接 new Date()，重放时无法得到同一个时间；请改用 ctx.newDate()`,
      'Math.random': `第 ${line} 行直接调用 Math.random()，重放时无法得到同一个随机数；请改用 ctx.random()`,
    };
    findings.push({ kind, message: messages[kind], line, column });
  }

  function declares(node: ts.Node): { fn: string[]; block: string[] } {
    const fn: string[] = [];
    const block: string[] = [];
    if (ts.isFunctionLike(node)) {
      for (const p of node.parameters) {
        if (ts.isIdentifier(p.name)) fn.push(p.name.text);
      }
      // function declarations hoist their own name into the parent function scope
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      // handled by caller into enclosing scope
    }
    if (ts.isVariableDeclarationList(node)) {
      const target = (node.flags & ts.NodeFlags.Const || node.flags & ts.NodeFlags.Let) ? block : fn;
      node.declarations.forEach((d) => collectPattern(d.name, target));
    }
    if (ts.isClassDeclaration(node) && node.name) block.push(node.name.text);
    if (ts.isImportDeclaration(node) && node.importClause) {
      const ic = node.importClause;
      if (ic.name) block.push(ic.name.text);
      if (ic.namedBindings) {
        if (ts.isNamespaceImport(ic.namedBindings)) block.push(ic.namedBindings.name.text);
        else ic.namedBindings.elements.forEach((e) => block.push(e.name.text));
      }
    }
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      block.push(node.variableDeclaration.name.text);
    }
    if (ts.isTypeAliasDeclaration(node)) block.push(node.name.text);
    return { fn, block };
  }

  function collectPattern(name: ts.BindingName, out: string[]) {
    if (ts.isIdentifier(name)) out.push(name.text);
    else {
      name.elements.forEach((el) => {
        if (ts.isBindingElement(el)) collectPattern(el.name, out);
      });
    }
  }

  function checkForbidden(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const pa = node.expression;
      if (
        ts.isIdentifier(pa.expression) &&
        pa.expression.text === 'Date' &&
        pa.name.text === 'now' &&
        node.arguments.length === 0 &&
        !isBound('Date')
      ) {
        addFinding('Date.now', node);
      }
      if (
        ts.isPropertyAccessExpression(pa.expression) === false &&
        ts.isIdentifier(pa.expression) &&
        pa.expression.text === 'Math' &&
        pa.name.text === 'random' &&
        node.arguments.length === 0 &&
        !isBound('Math')
      ) {
        addFinding('Math.random', node);
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      (!node.arguments || node.arguments.length === 0) &&
      !isBound('Date')
    ) {
      addFinding('new Date()', node);
    }
  }

  function visit(node: ts.Node) {
    checkForbidden(node);

    // Hoist function declarations & params into the enclosing function scope.
    if (ts.isFunctionDeclaration(node) && node.name) {
      current().fnScoped.add(node.name.text);
    }
    if (ts.isFunctionLike(node)) {
      const s: Scope = { fnScoped: new Set(), blockScoped: new Set(), kind: 'function' };
      for (const p of node.parameters) if (ts.isIdentifier(p.name)) s.fnScoped.add(p.name.text);
      stack.push(s);
      ts.forEachChild(node, visit);
      stack.pop();
      return;
    }

    if (ts.isBlock(node) && !ts.isFunctionLike(node.parent)) {
      stack.push({ fnScoped: new Set(), blockScoped: new Set(), kind: 'block' });
      // Hoist `var` declarations in the block.
      hoistVars(node, current());
      ts.forEachChild(node, visit);
      stack.pop();
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      stack.push({ fnScoped: new Set(), blockScoped: new Set(), kind: 'block' });
      ts.forEachChild(node, visit);
      stack.pop();
      return;
    }

    const { fn, block } = declares(node);
    fn.forEach((n) => current().fnScoped.add(n));
    block.forEach((n) => current().blockScoped.add(n));
    ts.forEachChild(node, visit);
  }

  function hoistVars(block: ts.Node, scope: Scope) {
    function v(n: ts.Node) {
      if (ts.isVariableDeclarationList(n) && !(n.flags & ts.NodeFlags.Const) && !(n.flags & ts.NodeFlags.Let)) {
        n.declarations.forEach((d) => {
          const names: string[] = [];
          collectPattern(d.name, names);
          names.forEach((x) => scope.fnScoped.add(x));
        });
      }
      if (!ts.isFunctionLike(n) && !ts.isBlock(n)) ts.forEachChild(n, v);
    }
    ts.forEachChild(block, v);
  }

  visit(sf);
  return findings;
}
