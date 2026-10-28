/**
 * A file's interface: what the other project files can see of it.
 *
 * Why
 * ───
 * - After an edit, the project's other files are diagnosed again only when
 *   the edited file's interface changed (ProjectModeService.rebuildAndReanalyzeAll).
 *   If the interface misses anything their diagnostics read, they keep stale
 *   warnings: so every edit below checks the diagnostics the client was left
 *   with against those of the same files analysed from scratch.
 * - Edits that only move things (game text, comments, new lines) must keep
 *   the interface, or nothing is saved.
 * - While no location's interface changes, the propagation of locals is
 *   kept (reusePropagation), with the edited locations' symbols swapped in;
 *   otherwise only the names the edited locations hold, and, where they
 *   call other locations with locals in scope, the names that reach them,
 *   are propagated again:
 *   the aggregates must equal those built from scratch, positions and all
 *   (hover and navigation read them), in a project and in a single file.
 * - The hash is made once per location and kept with it; an analysis read
 *   back from the cache must hash the same.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Connection, Diagnostic, TextDocuments } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { LocationSymbols, locationInterfaceHash, type DocumentSymbols } from '../src/parser';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { ProjectModeService } from '../src/server/projectMode';
import {
  buildFileAggregates, collectCallTypesPerTarget, emptyAggregates, fileAggregates, propagateLocals, propagationBase, reusePropagation,
  type PropagationBase, type SymbolAggregates,
} from '../src/server/aggregation';
import { extractLocationSymbols } from '../src/server/locationAnalysis';
import { decodeValue, encodeValue } from '../src/server/cacheFormat';
import type { DocumentState } from '../src/server/featureTypes';
import { PerfLog } from '../src/server/perfLog';
import { ALL_DIAGS_ON, initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

// The file edited below, and two that see it: globals, objects and actions
// across files, calls that pass locals, a code block run elsewhere, `args`
// and `result`, a location defined twice.
const MAIN = `# старт
! начало игры
$мир = 'Северный край'
счёт = 0
$код = { счёт += args[0] & result = счёт }
addobj 'Фонарь'
local шаг = 1
gs 'помощь', шаг
x = @считать(1, 2)
pl 'Добро пожаловать, <<$имя>>', $ответ
if счёт > 0:
  pl 'ещё не время'
  gt 'лес'
end
act 'Осмотреться':
  *pl 'Тишина.'
  dynamic $код, 2
  gs 'забытая', 1, 2
end
:метка
loop local i = 0 while i < 3 step i += 1:
  pl i, #сила
end
---
# общая
*pl 'то же имя, что в другом файле'
---
`;
const FOREST = `# лес
pl $мир, $погода
if obj 'Фонарь': delobj 'Фонарь'
gs 'помощь'
$ответ = 'да'
$сила = 'строка'
---
# помощь
pl шаг, args[0]
delact 'Осмотреться'
---
# считать
result = args[0] + args[1] + $код
---
# забытая
pl 'сюда никто не ходит'
---
`;
const OTHER = `# общая
pl 'и здесь'
---
# пустая
pl неизвестная
x = dyneval($код, 1)
---
`;

// Insert a letter, a space or a line break, or delete a character, at
// the start, middle and end of every line, plus edits that change one thing
// other locations may see. The test undoes each one, which is an edit too.
function editsOf(text: string): string[] {
  const lines = text.split('\n');
  const edits: string[] = [];
  let offset = 0;
  for (const line of lines) {
    for (const col of new Set([0, Math.floor(line.length / 2), line.length])) {
      const at = offset + col;
      for (const insert of ['x', ' ', '\n']) edits.push(text.slice(0, at) + insert + text.slice(at));
      if (col < line.length) edits.push(text.slice(0, at) + text.slice(at + 1));
    }
    offset += line.length + 1;
  }

  // Edits that change one thing other files may see.
  for (const [from, to] of [
    ["gs 'помощь', шаг", "gt 'помощь', шаг"],
    ["gs 'помощь', шаг", "gs 'помощь'"],
    ['x = @считать(1, 2)', "gs 'считать', 1, 2"],
    ['result = счёт', 'счёт = счёт'],
    ['#сила', '$сила'],
    ['local шаг = 1', 'шаг = 1'],
    ['local шаг = 1', 'local шаг'],
    ["$мир = 'Северный край'", "$мир = 'Южный край'"],
    ["$мир = 'Северный край'", "$мир += 'Южный край'"],
    ["$мир = 'Северный край'", 'killvar $мир'],
    ['$ответ', '$вопрос'],
    ["addobj 'Фонарь'", "delobj 'Фонарь'"],
    ["  gs 'забытая', 1, 2", "  gs 'забытая'"],
    ['  dynamic $код, 2', '  x = dyneval($код, 2)'],
    ["act 'Осмотреться':", "act 'Осмотреть':"],
    ["local шаг = 1\ngs 'помощь', шаг", "gs 'помощь', шаг\nlocal шаг = 1"],
  ]) {
    expect(text).toContain(from);
    edits.push(text.replace(from, to));
  }

  return edits;
}

function project() {
  const connection = {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    sendDiagnostics: () => {},
  } as unknown as Connection;
  const documents = { get: () => undefined, all: () => [] } as unknown as TextDocuments<TextDocument>;
  const states = new Map<string, DocumentState>();
  const service = new ProjectModeService(connection, documents, states, parser);
  const callTypes = () => collectCallTypesPerTarget([...states.values()].map(s => s.symbols));
  const peers = (own: string): DocumentSymbols[] => [...states].filter(([u]) => u !== own).map(([, s]) => s.symbols);
  const add = (uri: string, text: string) => {
    service.projectFileUris.add(uri);
    service.analyzeFile(uri, text);
  };
  return {
    service,
    add,
    symbolsOf: (uri: string) => states.get(uri)!.symbols,
    /** Diagnose as the server does after `changed` changed; returns the files it diagnosed. */
    async run(changed?: string): Promise<Map<string, Diagnostic[]>> {
      const out = new Map<string, Diagnostic[]>();
      await service.rebuildAndReanalyzeAll(ALL_DIAGS_ON, callTypes, peers, { collected: out, changed: changed === undefined ? undefined : [changed] });
      return out;
    },
    /** Every file's diagnostics from the current aggregates. */
    truth(): Map<string, Diagnostic[]> {
      const out = new Map<string, Diagnostic[]>();
      service.reanalyzeAll(ALL_DIAGS_ON, callTypes, peers, () => undefined, out);
      return out;
    },
  };
}

const A = 'file:///game/main.qsps';
const B = 'file:///game/forest.qsps';
const C = 'file:///game/other.qsps';

describe('file interface', () => {
  // Hundreds of edits, each checked against the project analysed from scratch: seconds.
  it('leaves the other files the diagnostics a full re-diagnosis gives them, edit after edit', async () => {
    const p = project();
    p.add(A, MAIN);
    p.add(B, FOREST);
    p.add(C, OTHER);
    const perfLines: string[] = [];
    p.service.perf = new PerfLog(line => perfLines.push(line));
    p.service.perf.verbose = true;
    const shown = await p.run();
    expect(shown.get(B)!.length + shown.get(C)!.length).toBeGreaterThan(0);

    const edits = editsOf(MAIN);

    let partial = 0;
    let reused = 0;
    for (const text of edits.flatMap(e => [e, MAIN])) {
      p.add(A, text);
      const diagnosed = await p.run(A);
      if (!diagnosed.has(B)) partial++;
      if (!/[·,] propagation \d/.test(perfLines.filter(l => l.includes('project aggregates')).at(-1)!)) reused++;
      for (const [uri, d] of diagnosed) shown.set(uri, d);
      // The same files analysed from scratch.
      const q = project();
      q.add(A, text);
      q.add(B, FOREST);
      q.add(C, OTHER);
      const truth = await q.run();
      for (const uri of [A, B, C]) expect(shown.get(uri), `${uri} after editing to:\n${text}`).toEqual(truth.get(uri));
      expect(p.service.projectAggregates, `aggregates after editing to:\n${text}`).toEqual(q.service.projectAggregates);
    }
    // Both ways were taken: text edits kept the interface, others changed it.
    // The propagation is kept whole while no interface changes, and in part
    // while the calls that pass locals stay the same.
    expect(reused).toBeGreaterThan(partial + 100);
    expect(partial).toBeGreaterThan(edits.length / 2);
    expect(partial).toBeLessThan(edits.length * 2);
  }, 30_000);

  it('gives a single file the aggregates a fresh build does, reusing the propagation across edits', () => {
    const p = project();
    const rest = FOREST + OTHER;
    let before: { symbols: DocumentSymbols; propagation?: PropagationBase; aggCache?: SymbolAggregates } | undefined;
    let reused = 0;
    for (const text of editsOf(MAIN).flatMap(e => [e, MAIN])) {
      p.add(A, text + rest);
      const symbols = p.symbolsOf(A);
      // As the server does: a new state, with the propagation of the one before.
      const state = { symbols, propagation: before?.propagation };
      const agg = fileAggregates(state, A);
      if (before && agg.propagationCallers === before.aggCache!.propagationCallers) reused++;
      expect(agg, `after editing to:\n${text}`).toEqual(buildFileAggregates(symbols, A));
      before = { ...state, aggCache: agg };
    }
    expect(reused).toBeGreaterThan(100);
  });

  it('propagates again what an edit changes for the propagation, past its limit of providers too', () => {
    // Ten callers pass `x` to one location: it takes eight, then only one
    // that brings what it lacks (a value, a type prefix).
    const callers = (i: number, decl: string) => `# в${i}\n${decl}\ngs 'цель'\n---\n`;
    const game = (ninth: string, tenth = 'local x = 1') =>
      "# цель\npl x\n---\n" + [1, 2, 3, 4, 5, 6, 7, 8].map(i => callers(i, 'local x')).join('') + callers(9, ninth) + callers(10, tenth);
    const scoped = (inside: boolean) => "# цель\npl y\n---\n# в\nif 1:\n  local y = 1\n" + (inside ? "  gs 'цель'\nend\n" : "end\ngs 'цель'\n") + '---\n';
    const steps = [game('local x'), game('local x = 2'), game('local $x'), game('local x'), scoped(true), scoped(false), scoped(true)];
    const p = project();
    let before: { symbols: DocumentSymbols; propagation?: PropagationBase } | undefined;
    for (const text of steps) {
      p.add(A, text);
      const state = { symbols: p.symbolsOf(A), propagation: before?.propagation };
      expect(fileAggregates(state, A), text).toEqual(buildFileAggregates(state.symbols, A));
      before = state;
    }
  });

  // A new call changes what reaches its location's callees, for the names
  // that reach the caller: `p` here, not `q`, whose providers are kept.
  it('propagates again, when calls change, only the names that reach the changed location', () => {
    const loc = (name: string, body: string) => {
      const text = `# ${name}\n${body}--- ${name} ---\n`;
      const tree = parser.parseOnce(text)!;
      try {
        return { locName: name, locSyms: extractLocationSymbols(tree, A, name, text, undefined), uri: A };
      } finally {
        tree.delete();
      }
    };
    const locations = [loc('a', "local p = 1\ngs 'b'\n"), loc('b', 'pl p\n'), loc('c', "local q = 2\ngs 'd'\n"), loc('d', 'pl p, q\n')];
    const before = emptyAggregates();
    propagateLocals(locations, before);
    const edited = [...locations];
    edited[1] = loc('b', "pl p\ngs 'd'\n");
    const after = emptyAggregates();
    expect(reusePropagation(propagationBase(locations, before), edited, after)).toBe(true);
    const fresh = emptyAggregates();
    propagateLocals(edited, fresh);
    expect(after.propagatedLocals).toEqual(fresh.propagatedLocals);
    expect(after.propagationCallers).toEqual(fresh.propagationCallers);
    expect([...after.propagatedLocals.get('d')!.keys()]).toEqual(['p', 'q']);
    expect(after.propagatedLocals.get('d')!.get('q')).toBe(before.propagatedLocals.get('d')!.get('q'));
  });

  it('diagnoses every file when a file is added or removed', async () => {
    const p = project();
    p.add(A, MAIN);
    p.add(B, FOREST);
    await p.run();
    p.add(C, OTHER);
    expect([...(await p.run(C)).keys()].sort()).toEqual([A, B, C].sort());
  });
});

describe('locationInterfaceHash', () => {
  const symbolsOf = (text: string) => {
    const name = text.slice(2, text.indexOf('\n'));
    return extractLocationSymbols(parser.parseOnce(text)!, A, name, text, t => parser.parseOnce(t));
  };
  const hash = (text: string) => locationInterfaceHash(symbolsOf(text));
  const base = `# комната\n$описание = 'тёмная комната'\nif есть: gs 'кухня', 1\npl 'текст'\n---\n`;

  it('stays when only positions or game text change', () => {
    for (const same of [
      base.replace("pl 'текст'", "pl 'другой, более длинный текст'"),
      base.replace('\nif', '\n\n! комментарий\n\nif'),
      base.replace('if есть:', 'if   есть  :'),
    ]) expect(hash(same)).toBe(hash(base));
    // A word list kept in a variable is text other files can't read.
    const list = (words: string) => `# комната\nlocal $имена = {\n  ${words},\n}\nscanstr '$все', $имена, '[\\w-]+'\n---\n`;
    expect(hash(list('Анна, Борис, Вера'))).toBe(hash(list('Анна, Борис, Варвара')));
  });

  it('changes with what a value or a block of code holds', () => {
    const withValue = (value: string) => `# комната\nсила = ${value}\n$код = { gs 'кухня' }\n---\n`;
    const plain = withValue('1');
    for (const other of [
      withValue('2'),
      withValue('сила + 1'),
      plain.replace("gs 'кухня'", "gs 'зал'"),
    ]) expect(hash(other)).not.toBe(hash(plain));
  });

  it('changes with what other files can see', () => {
    for (const other of [
      base.replace("'тёмная комната'", "'светлая комната'"),
      base.replace("gs 'кухня', 1", "gs 'кухня', 1, 2"),
      base.replace("gs 'кухня'", "gt 'кухня'"),
      base.replace('$описание', '$описание2'),
      base.replace('# комната', '# зал'),
    ]) expect(hash(other)).not.toBe(hash(base));
  });

  it('is the same for an analysis read back from the cache, and kept by copies', () => {
    const syms = symbolsOf(base);
    expect(LocationSymbols.copyWithLineShift(syms, 40).interfaceHash).toBe(syms.interfaceHash);
    const back = decodeValue(encodeValue(syms)) as LocationSymbols;
    expect(locationInterfaceHash(back)).toBe(locationInterfaceHash(syms));
  });
});
