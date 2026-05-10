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
} from './walkHelpers';
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
): void {
  let cursor = locBlock.walk();

  // ── Pre-scan: collect variable bindings + resolve call sites ────
  const callSiteTargets = new Map<number, Parser.SyntaxNode[]>();
  const untrackedByNodeId = new Map<
    number,
    { varName: string; reason: 'multiple-assignments' | 'complex-expression'; loc: import('./symbolTable').SymbolLocation }
  >();
  collectVariableBindings(
    locBlock, locSymbols, docUri,
    callSiteTargets, untrackedByNodeId,
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
  {
    const c2 = locBlock.walk();
    const find = () => {
      const n = c2.currentNode;
      if (callSiteTargets.has(n.id) || untrackedByNodeId.has(n.id)) {
        callSiteNodes.set(n.id, n);
      }
      if (c2.gotoFirstChild()) {
        do { find(); } while (c2.gotoNextSibling());
        c2.gotoParent();
      }
    };
    if (c2.gotoFirstChild()) {
      do { find(); } while (c2.gotoNextSibling());
      c2.gotoParent();
    }
    c2.delete();
  }
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

  // ── Recursive visitor ────────────────────────────────────────────
  function visit(): void {
    const node = cursor.currentNode;

    // Skip consumed or deferred code blocks.
    if (node.type === 'code_block') {
      if (consumedCodeBlocks.has(node.id)) return;
      if (deferredCodeBlocks.has(node.id)) return;

      // Dynamic/dyneval code blocks: caller locals propagate in (the
      // block runs in the caller's frame at runtime), but labels are
      // confined to the block — a `jump` cannot escape outwards nor
      // enter from outside.  So: variable-non-isolated, but a fresh
      // label namespace.
      if (locSymbols.dynamicCodeBlocks.has(node.id)) {
        const prevScope = scopeId;
        const prevLabelNs = labelNamespace;
        scopeId = newScope(prevScope, /* isolated */ false);
        labelNamespace = scopeId;
        if (cursor.gotoFirstChild()) {
          do { visit(); } while (cursor.gotoNextSibling());
          cursor.gotoParent();
        }
        scopeId = prevScope;
        labelNamespace = prevLabelNs;
        return;
      }

      // Other code blocks open a new *isolated* scope and a fresh
      // label namespace.
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
  if (cursor.gotoFirstChild()) {
    do {
      if (cursor.currentNode.type !== 'location_header'
        && cursor.currentNode.type !== 'location_end') {
        visit();
      }
    } while (cursor.gotoNextSibling());
    cursor.gotoParent();
  }
  cursor.delete();

  // ── Deferred walk: blocks targeted by var-mediated dynamic/dyneval
  // Each deferred block is walked inside a synthetic scope seeded with
  // the union of caller-site locals from every call site that resolves
  // to this block.  Walked in topological order so a callee block is
  // only walked after every caller block has propagated its locals in.
  const walkBlock = (entry: { node: Parser.SyntaxNode; locals: Map<string, import('./symbolTable').QspSymbol> }) => {
    const outer = newScope(0, /* isolated */ true);
    for (const [name, sym] of entry.locals) {
      locSymbols.injectLocalIntoScope(name, outer, sym);
    }
    const inner = newScope(outer, /* isolated */ false);

    const blockCursor = entry.node.walk();
    cursor = blockCursor;
    const savedScope = scopeId;
    const savedLabelNs = labelNamespace;
    scopeId = inner;
    // Stored code-block ⇒ fresh label namespace, isolated from callers.
    labelNamespace = outer;
    if (blockCursor.gotoFirstChild()) {
      do { visit(); } while (blockCursor.gotoNextSibling());
      blockCursor.gotoParent();
    }
    scopeId = savedScope;
    labelNamespace = savedLabelNs;
    blockCursor.delete();
  };

  const walked = new Set<number>();
  const remaining = new Set<number>(blockInboundLocals.keys());
  const maxIter = remaining.size + 1;
  for (let iter = 0; iter < maxIter && remaining.size > 0; iter++) {
    let picked: number | null = null;
    for (const id of remaining) {
      const callers = blockCallers.get(id);
      let ready = true;
      if (callers) {
        for (const c of callers) {
          if (c === 0) continue;
          if (c === id) continue;
          if (!walked.has(c)) { ready = false; break; }
        }
      }
      if (ready) { picked = id; break; }
    }
    if (picked === null) picked = remaining.values().next().value as number;

    const entry = blockInboundLocals.get(picked)!;
    walked.add(picked);
    remaining.delete(picked);
    walkBlock(entry);
  }
}
