/**
 * Tree-sitter AST walker for a single location block.
 *
 * Populates a LocationSymbols table by walking the AST with scope
 * tracking.  The walker dispatches each AST node to the appropriate
 * extractor (extractVariable, extractLabel, …) and manages scope
 * boundaries (act blocks, loops, if/else branches, code blocks).
 *
 * After the main walk, deferred code blocks targeted by var-mediated
 * `dynamic` / `dyneval` calls are walked in topological order with
 * caller-site locals injected into synthetic scopes.
 */


import type Parser from 'web-tree-sitter';
import type { LocationSymbols } from './locationSymbols';
import {
  type VarMediatedCtx,
  markConsumedCodeBlock,
  isTextBlock,
} from './walkHelpers';
import { blockStatements, forEachDescendant } from './blockTrees';
import {
  extractVariable,
  extractLabel,
  extractAction,
  extractLocationRef,
  extractFuncCallLocationRef,
  extractUserCallRef,
  extractObjOperator,
  checkArgCount,
  checkDeprecated,
  checkFuncCallPrefix,
} from './symbolExtractors';
import { collectVariableBindings } from './bindingCollector';
import { collectDeferredBlocks } from './bindingCollector';
import { interpolationNeedsDecode } from './embeddedInterpolation';

// ──────────────────────────────────────────────────────────────────────

/**
 * Walk all descendants inside a location_block and extract symbols:
 * variables, labels, actions, location references, object/action refs.
 *
 * Manages:
 *   • Per-location scope tracking (scopeId = 0 at top level, nextScope++).
 *   • Per-location label namespaces — fresh on entry to every act,
 *     stored code_block, dynamic/dyneval block, or deferred block.
 *   • Consumed code-block skipping (goto {loc}, killvar {x}, etc.).
 *   • Dynamic/dyneval code-block variable-scope inheritance (caller
 *     locals propagate in, but a fresh label namespace).
 *   • Deferred walk of blocks targeted by var-mediated dynamic/dyneval
 *     (walked after the main pass with caller-site locals injected).
 */
export function walkLocationBody(
  locBlock: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  /**
   * When `true`, every var-mediated `dynamic`/`dyneval` call inside
   * `locBlock` whose first arg fails intra-location resolution is
   * routed to {@link LocationSymbols.deferredDynamicVarCalls}
   * regardless of lexical context.  Set by `embeddedExec.ts` when
   * walking a synthetic location built from an `<a href="exec:…">`
   * link body — every statement inside such a body runs at click
   * time in a fresh frame, so caller-propagated locals must not
   * shadow cross-loc global lookup.
   */
  inDeferredExecution = false,
): void {
  // Assigned right before each walk so a throw can't leak it (see the finally blocks below).
  let cursor: Parser.TreeCursor;

  // ── Pre-scan: collect variable bindings + resolve call sites ────
  const callSiteTargets = new Map<number, Parser.SyntaxNode[]>();
  const untrackedByNodeId = new Map<
    number,
    { varName: string; reason: 'multiple-assignments' | 'complex-expression'; loc: import('./symbolTable').SymbolLocation }
  >();
  collectVariableBindings(
    locBlock, locSymbols, docUri,
    callSiteTargets, untrackedByNodeId,
    inDeferredExecution,
  );

  // ── Deferred-block bookkeeping ──────────────────────────────────
  const deferredCodeBlocks = new Set<number>();
  const blockInboundLocals = new Map<
    number,
    { node: Parser.SyntaxNode; locals: Map<string, import('./symbolTable').QspSymbol> }
  >();
  const blockCallers = new Map<number, Set<number>>();

  // Build stmtId → stmtNode lookup for collectDeferredBlocks.
  const callSiteNodes = new Map<number, Parser.SyntaxNode>();
  forEachDescendant(locBlock, n => {
    if (callSiteTargets.has(n.id) || untrackedByNodeId.has(n.id)) callSiteNodes.set(n.id, n);
  });
  collectDeferredBlocks(
    callSiteTargets, callSiteNodes,
    deferredCodeBlocks, blockInboundLocals, blockCallers,
  );

  const consumedCodeBlocks = new Set<number>();

  const ctx: VarMediatedCtx = {
    consumedCodeBlocks,
    deferredCodeBlocks,
    blockInboundLocals,
    callSiteTargets,
  };

  // ── Scope tracking ──────────────────────────────────────────────
  // `scopeId`        — variable-scope chain (every if/loop/act/code_block).
  // `labelNamespace` — current label bucket key.  Distinct from scopeId
  //   because labels and locals do not share isolation rules: every act,
  //   stored code_block, AND dynamic/dyneval block opens a fresh label
  //   namespace, but only act + stored code_block isolate locals.
  let scopeId = 0;
  let labelNamespace = 0;
  let nextScope = 1;

  function newScope(parent: number, isolated = false): number {
    const id = nextScope++;
    locSymbols.scopeParent.set(id, parent);
    if (isolated) locSymbols.isolatedScopes.add(id);
    return id;
  }

  // A block's statements, each walked with a cursor of its own.
  function visitStatements(block: Parser.SyntaxNode): void {
    const outer = cursor;
    try {
      for (const stmt of blockStatements(block)) {
        cursor = stmt.walk();
        try {
          visit();
        } finally {
          cursor.delete();
        }
      }
    } finally {
      cursor = outer;
    }
  }

  // ── Recursive visitor ────────────────────────────────────────────
  function visit(): void {
    const node = cursor.currentNode;

    // Interpolations whose body carries the host string's doubled-quote
    // escape are captured by the grammar as an opaque
    // `interpolation_raw_body` token; a post-walk pass
    // (`extractEmbeddedInterpolations`) decodes the body and
    // sub-parses it.  Skip descent here (the raw token has no symbol
    // children anyway) and capture the CURRENT scopeId so the
    // post-pass can resolve refs against host locals (in-scope `act` /
    // `loop` / `if` bodies) the same way the inline path does for
    // clean interpolations.
    if (node.type === 'string_interpolation' && interpolationNeedsDecode(node)) {
      locSymbols.interpolationHostScopes.set(node.id, scopeId);
      return;
    }

    // Skip consumed or deferred code blocks, and those that are text.
    if (node.type === 'code_block') {
      if (isTextBlock(node)) return;
      if (consumedCodeBlocks.has(node.id)) return;
      if (deferredCodeBlocks.has(node.id)) return;

      // Inline dynamic/dyneval block: lexically anchored, so the
      // scope chain already points at the right caller — no isolation
      // needed.  Deferred (var-mediated) dynamic blocks below take
      // the opposite path: isolated + locals injected.  Either way,
      // labels are confined — fresh label namespace.
      if (locSymbols.dynamicCodeBlocks.has(node.id)) {
        const prevScope = scopeId;
        const prevLabelNs = labelNamespace;
        scopeId = newScope(prevScope, /* isolated */ false);
        labelNamespace = scopeId;
        visitStatements(node);
        scopeId = prevScope;
        labelNamespace = prevLabelNs;
        return;
      }

      // Other code blocks (string-arg code literals used by `gt`,
      // `killvar`, etc.) open a new *isolated* scope and a fresh
      // label namespace.
      const prevScope = scopeId;
      const prevLabelNs = labelNamespace;
      scopeId = newScope(prevScope, /* isolated */ true);
      labelNamespace = scopeId;
      visitStatements(node);
      scopeId = prevScope;
      labelNamespace = prevLabelNs;
      return;
    }

    switch (node.type) {
      case 'variable_ref':
      case 'ml_variable_ref':
        extractVariable(node, locSymbols, docUri, scopeId);
        break;

      case 'label_statement':
        extractLabel(node, locSymbols, docUri, labelNamespace);
        return;

      case 'act_block':
      case 'act_inline': {
        extractAction(node, locSymbols, docUri);
        markConsumedCodeBlock(node, ctx, locSymbols, scopeId, docUri);
        const prevScope = scopeId;
        const prevLabelNs = labelNamespace;
        scopeId = newScope(prevScope, /* isolated */ true);
        labelNamespace = scopeId;
        if (cursor.gotoFirstChild()) {
          do { visit(); } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
        scopeId = prevScope;
        labelNamespace = prevLabelNs;
        return;
      }

      case 'loop_block':
      case 'loop_inline': {
        const loopScope = newScope(scopeId);
        const prevScope = scopeId;
        scopeId = loopScope;
        if (cursor.gotoFirstChild()) {
          do { visit(); } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
        scopeId = prevScope;
        return;
      }

      case 'if_block': {
        const parentScope = scopeId;
        const bodyScope = newScope(parentScope);
        if (cursor.gotoFirstChild()) {
          do {
            const child = cursor.currentNode;
            if (child.type === 'elseif_clause' || child.type === 'else_clause') {
              visit();
            } else if (child.isNamed
              && child.type !== 'if_keyword' && child.type !== 'end_keyword'
              && child.type !== 'note_string' && child.type !== 'comment_statement') {
              const prev = scopeId;
              scopeId = bodyScope;
              visit();
              scopeId = prev;
            } else {
              visit();
            }
          } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
        scopeId = parentScope;
        return;
      }

      case 'if_inline': {
        const parentScope = scopeId;
        const bodyScope = newScope(parentScope);
        if (cursor.gotoFirstChild()) {
          do {
            const child = cursor.currentNode;
            if (child.type === 'elseif_inline' || child.type === 'else_inline') {
              visit();
            } else if (child.type !== 'if_keyword') {
              const prev = scopeId;
              scopeId = bodyScope;
              visit();
              scopeId = prev;
            } else {
              visit();
            }
          } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
        scopeId = parentScope;
        return;
      }

      case 'elseif_clause':
      case 'else_clause':
      case 'elseif_inline':
      case 'else_inline': {
        const prevScope = scopeId;
        scopeId = newScope(prevScope);
        if (cursor.gotoFirstChild()) {
          do { visit(); } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
        scopeId = prevScope;
        return;
      }

      case 'statement':
        extractLocationRef(node, locSymbols, docUri, scopeId, labelNamespace);
        markConsumedCodeBlock(node, ctx, locSymbols, scopeId, docUri);
        checkArgCount(node, locSymbols, docUri);
        checkDeprecated(node, locSymbols, docUri);
        break;

      case 'na_func_call':
      case 'ext_func_call':
      case 'ml_func_call':
        extractFuncCallLocationRef(node, locSymbols, docUri, scopeId);
        markConsumedCodeBlock(node, ctx, locSymbols, scopeId, docUri);
        checkFuncCallPrefix(node, locSymbols, docUri);
        checkArgCount(node, locSymbols, docUri);
        checkDeprecated(node, locSymbols, docUri);
        break;

      case 'user_call_statement':
      case 'user_func_call':
      case 'ml_user_func_call':
        extractUserCallRef(node, locSymbols, docUri, scopeId);
        break;

      case 'na_unary':
      case 'ext_unary':
      case 'ml_unary':
        extractObjOperator(node, locSymbols, docUri, scopeId);
        markConsumedCodeBlock(node, ctx, locSymbols, scopeId, docUri);
        break;
    }

    // Recurse into children (unless handler already returned).
    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  }

  // ── Start the main walk ─────────────────────────────────────────
  cursor = locBlock.walk();
  try {
    if (cursor.gotoFirstChild()) {
      do {
        if (cursor.currentNode.type !== 'location_header'
          && cursor.currentNode.type !== 'location_end') {
          visit();
        }
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  } finally {
    cursor.delete();
  }

  // ── Deferred walk: blocks targeted by var-mediated dynamic/dyneval
  //
  // Walked out of lexical context (same block may be reached from many
  // call sites), so each gets an ISOLATED outer scope SEEDED with the
  // union of caller-site locals via `injectLocalIntoScope`.  This
  // "isolated + injected" combination is unique to deferred dynamic
  // blocks — contrast inline dynamic blocks above.
  //
  // Topological order: a callee block is walked only after every
  // caller block has propagated its locals in.
  const walkBlock = (entry: { node: Parser.SyntaxNode; locals: Map<string, import('./symbolTable').QspSymbol> }) => {
    // Running a block that isn't code fails on its syntax, reported as such:
    // its words are no variables.
    if (isTextBlock(entry.node)) return;
    const outer = newScope(0, /* isolated */ true);
    for (const [name, sym] of entry.locals) {
      locSymbols.injectLocalIntoScope(name, outer, sym);
    }
    const inner = newScope(outer, /* isolated */ false);

    const savedScope = scopeId;
    const savedLabelNs = labelNamespace;
    scopeId = inner;
    // Stored code-block ⇒ fresh label namespace, isolated from callers.
    labelNamespace = outer;
    try {
      visitStatements(entry.node);
    } finally {
      scopeId = savedScope;
      labelNamespace = savedLabelNs;
    }
  };

  // Each block once the blocks that run it are walked, the first in order
  // that is; in a cycle, the first left. Counted down rather than searched
  // for: a search over the blocks left at each step took seconds for a
  // few thousand blocks kept in variables.
  const order = [...blockInboundLocals.keys()];
  const waitingFor = new Int32Array(order.length);
  const unblocks = new Map<number, number[]>();
  order.forEach((id, i) => {
    for (const c of blockCallers.get(id) ?? []) {
      if (c === 0 || c === id) continue;
      waitingFor[i]++;
      let list = unblocks.get(c);
      if (!list) unblocks.set(c, list = []);
      list.push(i);
    }
  });
  const done = new Uint8Array(order.length);
  const ready = new MinHeap();
  order.forEach((_, i) => { if (waitingFor[i] === 0) ready.push(i); });
  let firstLeft = 0;
  for (let n = 0; n < order.length; n++) {
    let picked = ready.pop();
    while (picked !== undefined && done[picked]) picked = ready.pop();
    if (picked === undefined) {
      while (done[firstLeft]) firstLeft++;
      picked = firstLeft;
    }
    done[picked] = 1;
    walkBlock(blockInboundLocals.get(order[picked])!);
    for (const j of unblocks.get(order[picked]) ?? []) {
      if (--waitingFor[j] === 0 && !done[j]) ready.push(j);
    }
  }
}

// The smallest of the numbers pushed, popped first.
class MinHeap {
  private readonly items: number[] = [];

  push(x: number): void {
    const a = this.items;
    a.push(x);
    for (let i = a.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (a[up] <= a[i]) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }

  pop(): number | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
