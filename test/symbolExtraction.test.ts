import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { WASM_PATH } from './testHelpers';

describe('extractSymbols', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should extract location definitions', () => {
    const tree = parser.parse('test://syms', `# myLocation
pl 'hello'
---
# another
x = 1
---
`);
    expect(tree).not.toBeNull();

    const { symbols } = extractSymbols(tree!, 'test://syms');
    expect(symbols.locationDefs.size).toBe(2);
    expect(symbols.locationDefs.has('mylocation')).toBe(true);
    expect(symbols.locationDefs.has('another')).toBe(true);
  });

  it('should extract variable definitions', () => {
    const tree = parser.parse('test://vars', `# test
x = 1
$name = 'Alice'
local temp = 5
---
`);
    expect(tree).not.toBeNull();

    const { symbols } = extractSymbols(tree!, 'test://vars');
    const locSyms = symbols.getLocation('test');
    expect(locSyms).toBeDefined();

    // Check that variables were found
    expect(locSyms!.variables.size).toBe(3);

    // x should be a global variable definition
    const xSym = locSyms!.variables.get('x');
    expect(xSym).toBeDefined();
    expect(xSym!.definition).toBeDefined();
    expect(xSym!.isLocal).toBe(false);

    // $name and name refer to the same variable in QSP —
    // the key is just the base name, prefix is an operator.
    const nameSym = locSyms!.variables.get('name');
    expect(nameSym).toBeDefined();

    // local temp should be local
    const tempSym = locSyms!.findVariable('temp');
    expect(tempSym).toBeDefined();
    expect(tempSym!.isLocal).toBe(true);
  });

  it('should extract labels', () => {
    const tree = parser.parse('test://labels', `# test
:myLabel
pl 'at label'
---
`);
    expect(tree).not.toBeNull();

    const { symbols } = extractSymbols(tree!, 'test://labels');
    const locSyms = symbols.getLocation('test');
    expect(locSyms).toBeDefined();
    expect(locSyms!.labels.size).toBe(1);
    expect(locSyms!.getLabel('mylabel', 0)).toBeDefined();
  });

  it('should extract action definitions', () => {
    const tree = parser.parse('test://acts', `# test
act 'Open door':
  pl 'Door opened'
end
---
`);
    expect(tree).not.toBeNull();

    const { symbols } = extractSymbols(tree!, 'test://acts');
    const locSyms = symbols.getLocation('test');
    expect(locSyms).toBeDefined();
    expect(locSyms!.actions.length).toBe(1);
    expect(locSyms!.actions[0].name).toBe('Open door');
  });

  it('should extract location references from gosub', () => {
    const tree = parser.parse('test://refs', `# main
gosub 'helper'
---
# helper
pl 'helping'
---
`);
    expect(tree).not.toBeNull();

    const { symbols } = extractSymbols(tree!, 'test://refs');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.locationRefs.size).toBe(1);
    expect([...mainSyms!.locationRefs.values()][0].nameLower).toBe('helper');
  });

  it('should handle unicode identifiers', () => {
    const tree = parser.parse('test://unicode', `# тест
Имя = 'Алиса'
---
`);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);

    const { symbols } = extractSymbols(tree!, 'test://unicode');
    expect(symbols.locationDefs.has('тест')).toBe(true);
  });

  it('should handle if/else blocks', () => {
    const tree = parser.parse('test://ifelse', `# test
if x > 0:
  pl 'positive'
elseif x = 0: pl 'zero'
else pl 'negative'
end
---
`);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
  });

  it('should treat #var and %var as same variable as var', () => {
    const tree = parser.parse('test://prefix-var', `# test
arr[0] = 1
pl #arr
pl %arr
---
`);
    expect(tree).not.toBeNull();
    const { symbols } = extractSymbols(tree!, 'test://prefix-var');
    const locSyms = symbols.getLocation('test');
    expect(locSyms).toBeDefined();
    // All three (arr, #arr, %arr) should map to the same key
    const arrSym = locSyms!.variables.get('arr');
    expect(arrSym).toBeDefined();
    expect(arrSym!.references.length).toBe(3);
  });

  it('should extract variable with array index', () => {
    const tree = parser.parse('test://array-var', `# test
arr[1] = 5
pl arr[2]
---
`);
    expect(tree).not.toBeNull();
    const { symbols } = extractSymbols(tree!, 'test://array-var');
    const locSyms = symbols.getLocation('test');
    expect(locSyms).toBeDefined();
    const arrSym = locSyms!.variables.get('arr');
    expect(arrSym).toBeDefined();
    expect(arrSym!.definition).toBeDefined();
    expect(arrSym!.references.length).toBe(2);
  });

  it('should extract multiple actions in one location', () => {
    const tree = parser.parse('test://multi-act', `# test
act 'First': pl '1'
act 'Second':
  pl '2'
end
act 'Third': pl '3'
---
`);
    expect(tree).not.toBeNull();
    const { symbols } = extractSymbols(tree!, 'test://multi-act');
    const locSyms = symbols.getLocation('test');
    expect(locSyms).toBeDefined();
    expect(locSyms!.actions.length).toBe(3);
    expect(locSyms!.actions[0].name).toBe('First');
    expect(locSyms!.actions[1].name).toBe('Second');
    expect(locSyms!.actions[2].name).toBe('Third');
  });

  it('should handle nested blocks (act inside if)', () => {
    const tree = parser.parse('test://nested', `# test
if x > 0:
  act 'Nested action':
    pl 'inside'
  end
end
---
`);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
    const { symbols } = extractSymbols(tree!, 'test://nested');
    const locSyms = symbols.getLocation('test');
    expect(locSyms).toBeDefined();
    expect(locSyms!.actions.length).toBe(1);
    expect(locSyms!.actions[0].name).toBe('Nested action');
    // Variable x should also be extracted
    expect(locSyms!.variables.has('x')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Location reference extraction
// ──────────────────────────────────────────────────────────────────────

describe('extractSymbols — location references', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it.each([
    ['gosub', "gosub 'target'"],
    ['gs', "gs 'target'"],
    ['goto', "goto 'target'"],
    ['gt', "gt 'target'"],
    ['xgoto', "xgoto 'target'"],
    ['xgt', "xgt 'target'"],
    ['func', "x = func('target')"],
    ['$func', "$x = $func('target')"],
    ['@name', '@target'],
  ])('should extract refs from %s', (keyword, code) => {
    const uri = `test://lr-${keyword}`;
    const tree = parser.parse(uri, `# main\n${code}\n---\n`);
    const { symbols } = extractSymbols(tree!, uri);
    const refs = symbols.findLocationReferences('target');
    expect(refs).toHaveLength(1);
  });

  it('should NOT create location refs for non-location statements', () => {
    const tree = parser.parse('test://lr-no-ref', `# main
pl 'target'
msg 'target'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://lr-no-ref');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.locationRefs.size).toBe(0);
  });

  it('should find multiple refs to the same location', () => {
    const tree = parser.parse('test://lr-multi', `# main
gosub 'helper'
gs 'helper'
x = func('helper')
---
# helper
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://lr-multi');
    const refs = symbols.findLocationReferences('helper');
    // definition (header) + 3 references = 4
    expect(refs.length).toBe(4);
  });

  it('should track ref positions inside the string (excluding quotes)', () => {
    const tree = parser.parse('test://lr-pos', `# main
gosub 'myLoc'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://lr-pos');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.locationRefs.size).toBe(1);

    const ref = [...mainSyms!.locationRefs.values()][0];
    expect(ref.references[0].line).toBe(1);
    // Column should point inside the quotes: gosub 'myLoc'
    //                                        0123456 7
    expect(ref.references[0].column).toBe(7);
  });

  it('should handle double-quoted strings in refs', () => {
    const tree = parser.parse('test://lr-dquote', `# main
gosub "target"
---
`);
    const { symbols } = extractSymbols(tree!, 'test://lr-dquote');
    const refs = symbols.findLocationReferences('target');
    expect(refs).toHaveLength(1);
  });

  it('should be case-insensitive for location matching', () => {
    const tree = parser.parse('test://lr-case', `# MyLoc
pl 'hi'
---
# main
gosub 'myloc'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://lr-case');
    const refs = symbols.findLocationReferences('MyLoc');
    // Definition of MyLoc + reference from gosub
    expect(refs.length).toBe(2);
  });
});

describe('label reference extraction', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should track jump label references', () => {
    const tree = parser.parse('test://label-ref', `# main
:myLabel
pl 'hello'
jump 'myLabel'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://label-ref');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.labelRefs.size).toBe(1);
    expect([...mainSyms!.allLabelRefSymbols()][0].nameLower).toBe('mylabel');
  });

  it('should position label ref inside quotes', () => {
    const tree = parser.parse('test://label-pos', `# main
:start
jump 'start'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://label-pos');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    const ref = [...mainSyms!.allLabelRefSymbols()][0];
    // jump 'start'
    // 0123456
    expect(ref.references[0].column).toBe(6);
  });

  it('should find label refs via findLabelReferences', () => {
    const tree = parser.parse('test://label-find', `# main
:loop
pl 'tick'
jump 'loop'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://label-find');
    const refs = symbols.findLabelReferences('loop', 'main');
    // 1 definition + 1 jump reference
    expect(refs.length).toBe(2);
  });

  it('should be case-insensitive for label refs', () => {
    const tree = parser.parse('test://label-case', `# main
:MyLabel
jump 'MYLABEL'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://label-case');
    const refs = symbols.findLabelReferences('mylabel', 'main');
    expect(refs.length).toBe(2);
  });

  it('should exclude leading space from label definition range', () => {
    const tree = parser.parse('test://label-space', `# main
: spaced
jump 'spaced'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://label-space');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    const label = mainSyms!.getLabel('spaced', 0);
    expect(label).toBeDefined();
    // ": spaced"  →  name should start at column 2, not 1
    // 0123456789
    expect(label!.definition!.column).toBe(2);
    expect(label!.definition!.endColumn).toBe(8);
  });

  it('should scope label refs to their location', () => {
    const tree = parser.parse('test://label-scope', `# loc1
:start
jump 'start'
---
# loc2
:start
jump 'start'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://label-scope');
    const loc1Refs = symbols.findLabelReferences('start', 'loc1');
    const loc2Refs = symbols.findLabelReferences('start', 'loc2');
    expect(loc1Refs.length).toBe(2);
    expect(loc2Refs.length).toBe(2);
  });

  it('should trim spaces inside quotes for label refs', () => {
    const tree = parser.parse('test://label-trim', `# main
:myLabel
jump '  myLabel  '
---
`);
    const { symbols } = extractSymbols(tree!, 'test://label-trim');
    // The spaced reference should still match the label
    const refs = symbols.findLabelReferences('myLabel', 'main');
    expect(refs.length).toBe(2);

    // The jump ref range should cover only 'myLabel', not the spaces
    const mainSyms = symbols.getLocation('main');
    const jumpRef = mainSyms!.getLabelRef('mylabel', 0)!;
    // jump '  myLabel  '
    // 0123456789...
    // quote at col 5, then 2 spaces, then 'myLabel' starts at col 8
    expect(jumpRef.references[0].column).toBe(8);
    expect(jumpRef.references[0].endColumn).toBe(15);
  });
});

describe('location reference extraction', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should trim spaces inside quotes for location refs', () => {
    const tree = parser.parse('test://loc-trim', `# start
gosub '  room1  '
---
# room1
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loc-trim');
    // The spaced reference should still match the location def
    const refs = symbols.findLocationReferences('room1');
    expect(refs.length).toBe(2); // 1 definition + 1 gosub reference

    // The gosub ref range should cover only 'room1', not the spaces
    const startSyms = symbols.getLocation('start');
    const gosubRef = [...startSyms!.locationRefs.values()][0];
    // gosub '  room1  '
    // 0123456789...
    // quote at col 6, then 2 spaces, then 'room1' starts at col 9
    expect(gosubRef.references[0].column).toBe(9);
    expect(gosubRef.references[0].endColumn).toBe(14);
  });
});

describe('object reference extraction', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should track addobj/delobj as object references', () => {
    const tree = parser.parse('test://obj-ref', `# main
addobj 'Sword'
delobj 'Sword'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://obj-ref');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.objectRefs.size).toBe(1);
    expect(mainSyms!.objectRefs.get('sword')).toBeDefined();
    expect(mainSyms!.objectRefs.get('sword')!.references.length).toBe(2);
  });

  it('should track spaced forms add obj/del obj/mod obj', () => {
    const tree = parser.parse('test://obj-spaced', `# main
add obj 'Shield'
del obj 'Shield'
mod obj 'Shield','New Shield'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://obj-spaced');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.objectRefs.size).toBe(1);
    expect(mainSyms!.objectRefs.get('shield')!.name).toBe('Shield');
  });

  it('should track modobj (non-spaced form) as object reference', () => {
    const tree = parser.parse('test://obj-modobj', `# main
modobj 'Sword','Super Sword'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://obj-modobj');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.objectRefs.size).toBe(1);
    expect(mainSyms!.objectRefs.get('sword')!.name).toBe('Sword');
  });

  it('should find object refs case-insensitively via findObjectReferences', () => {
    const tree = parser.parse('test://obj-case', `# main
addobj 'Magic Sword'
delobj 'magic sword'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://obj-case');
    const refs = symbols.findObjectReferences('MAGIC SWORD');
    expect(refs.length).toBe(2);
  });

  it('should preserve spaces in object names (not trim)', () => {
    const tree = parser.parse('test://obj-space', `# main
addobj '  Sword  '
addobj 'Sword'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://obj-space');
    const mainSyms = symbols.getLocation('main');
    // '  Sword  ' and 'Sword' are different names
    expect(mainSyms!.objectRefs.get('  sword  ')!.name).toBe('  Sword  ');
    expect(mainSyms!.objectRefs.get('sword')!.name).toBe('Sword');
    // findObjectReferences should NOT match them
    const refs = symbols.findObjectReferences('Sword');
    expect(refs.length).toBe(1);
  });

  it('should position object ref range inside quotes', () => {
    const tree = parser.parse('test://obj-pos', `# main
addobj 'Sword'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://obj-pos');
    const mainSyms = symbols.getLocation('main');
    const ref = [...mainSyms!.objectRefs.values()][0];
    // addobj 'Sword'
    // 0123456789...
    // quote at col 7, content starts at col 8
    expect(ref.references[0].column).toBe(8);
    expect(ref.references[0].endColumn).toBe(13);
  });

  it('should track obj operator as object reference', () => {
    const tree = parser.parse('test://obj-op', `# main
if obj 'Sword': pl 'yes'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://obj-op');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.objectRefs.size).toBe(1);
    expect(mainSyms!.objectRefs.get('sword')!.name).toBe('Sword');
  });
});

describe('action reference extraction', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should track act definitions with accurate string range', () => {
    const tree = parser.parse('test://act-def', `# main
act 'Go north':
  pl 'walking'
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-def');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.actions.length).toBe(1);
    expect(mainSyms!.actions[0].name).toBe('Go north');
    // act 'Go north':
    // 0123456789...
    // quote at col 4, content starts at col 5
    expect(mainSyms!.actions[0].definition!.column).toBe(5);
    expect(mainSyms!.actions[0].definition!.endColumn).toBe(13);
  });

  it('should track delact as action reference', () => {
    const tree = parser.parse('test://act-ref', `# main
act 'Go north': pl 'hi'
delact 'Go north'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-ref');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.actionRefs.size).toBe(1);
    expect(mainSyms!.actionRefs.get('go north')!.name).toBe('Go north');
  });

  it('should track del act (spaced form) as action reference', () => {
    const tree = parser.parse('test://act-delsp', `# main
act 'Go north': pl 'hi'
del act 'Go north'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-delsp');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.actionRefs.size).toBe(1);
    expect(mainSyms!.actionRefs.get('go north')!.name).toBe('Go north');
  });

  it('should find action refs case-insensitively via findActionReferences', () => {
    const tree = parser.parse('test://act-case', `# main
act 'Go North': pl 'hi'
delact 'go north'
del act 'GO NORTH'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-case');
    const refs = symbols.findActionReferences('Go North');
    // 1 act definition + 2 delact references
    expect(refs.length).toBe(3);
  });

  it('should preserve spaces in action names (not trim)', () => {
    const tree = parser.parse('test://act-space', `# main
act 'Go': pl 'a'
act '  Go  ': pl 'b'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-space');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.actions[0].name).toBe('Go');
    expect(mainSyms!.actions[1].name).toBe('  Go  ');
    // Different names, so findActionReferences should not cross-match
    const refs = symbols.findActionReferences('Go');
    expect(refs.length).toBe(1);
  });

  it('should find symbol at position for actions', () => {
    const tree = parser.parse('test://sym-pos', `# main
act 'Go north': pl 'hi'
delact 'Go north'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sym-pos');
    // Cursor on 'Go north' in the act definition (line 1, col 6)
    const sym1 = symbols.findSymbolAtPosition(1, 6);
    expect(sym1).toBeDefined();
    expect(sym1!.kind).toBe('action');
    expect(sym1!.name).toBe('Go north');

    // Cursor on 'Go north' in delact (line 2, col 9)
    const sym2 = symbols.findSymbolAtPosition(2, 9);
    expect(sym2).toBeDefined();
    expect(sym2!.kind).toBe('action');
    expect(sym2!.name).toBe('Go north');
  });

  it('should find symbol at position for objects', () => {
    const tree = parser.parse('test://sym-obj', `# main
addobj 'Sword'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sym-obj');
    // Cursor on 'Sword' (line 1, col 9)
    const sym = symbols.findSymbolAtPosition(1, 9);
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('object');
    expect(sym!.name).toBe('Sword');
  });
});

describe('desc and loc operator tracking', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should track desc() as location reference', () => {
    const tree = parser.parse('test://desc-ref', `# main
$text = $desc('room1')
---
# room1
pl 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://desc-ref');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.locationRefs.size).toBe(1);
    expect([...mainSyms!.locationRefs.values()][0].nameLower).toBe('room1');
  });

  it('should track loc operator as location reference', () => {
    const tree = parser.parse('test://loc-ref', `# main
if loc 'room1': pl 'exists'
---
# room1
pl 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loc-ref');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    expect(mainSyms!.locationRefs.size).toBe(1);
    expect([...mainSyms!.locationRefs.values()][0].nameLower).toBe('room1');
  });

  it('should trim whitespace for loc operator (whitespace-tolerant)', () => {
    const tree = parser.parse('test://loc-trim', `# main
if loc '  room1  ': pl 'exists'
---
# room1
pl 'x'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loc-trim');
    const refs = symbols.findLocationReferences('room1');
    // definition of room1 + loc reference
    expect(refs.length).toBe(2);
  });
});

describe('code block {…} used as string argument', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  // ── Location references ──

  it('goto {loc} creates location reference', () => {
    const tree = parser.parse('test://cb-goto', `# main
goto {target}
---
# target
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-goto');
    const refs = symbols.findLocationReferences('target');
    expect(refs).toHaveLength(2); // def + ref
  });

  it('gosub {loc} creates location reference', () => {
    const tree = parser.parse('test://cb-gosub', `# main
gosub {target}
---
# target
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-gosub');
    const refs = symbols.findLocationReferences('target');
    expect(refs).toHaveLength(2);
  });

  it('func({loc}) creates location reference', () => {
    const tree = parser.parse('test://cb-func', `# main
x = func({helper})
---
# helper
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-func');
    const refs = symbols.findLocationReferences('helper');
    expect(refs).toHaveLength(2);
  });

  it('loc {name} operator creates location reference', () => {
    const tree = parser.parse('test://cb-loc', `# main
if loc {room1}: pl 'exists'
---
# room1
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-loc');
    const refs = symbols.findLocationReferences('room1');
    expect(refs).toHaveLength(2);
  });

  // ── Label references ──

  it('jump {label} creates label reference', () => {
    const tree = parser.parse('test://cb-jump', `# main
:myLabel
jump {myLabel}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-jump');
    const refs = symbols.findLabelReferences('myLabel', 'main');
    expect(refs.length).toBe(2); // definition + ref
  });

  // ── Object references ──

  it('addobj {name} creates object reference', () => {
    const tree = parser.parse('test://cb-addobj', `# main
addobj {Sword}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-addobj');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.objectRefs.size).toBe(1);
    expect(mainSyms!.objectRefs.get('sword')!.name).toBe('Sword');
  });

  it('delobj {name} creates object reference', () => {
    const tree = parser.parse('test://cb-delobj', `# main
addobj {Sword}
delobj {Sword}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-delobj');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.objectRefs.get('sword')!.references.length).toBe(2);
  });

  it('obj {name} operator creates object reference', () => {
    const tree = parser.parse('test://cb-obj', `# main
if obj {Sword}: pl 'yes'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-obj');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.objectRefs.size).toBe(1);
    expect(mainSyms!.objectRefs.get('sword')!.name).toBe('Sword');
  });

  // ── Action definitions and references ──

  it('act {name}: creates action definition', () => {
    const tree = parser.parse('test://cb-act', `# main
act {Go north}: pl 'walking'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-act');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.actions.length).toBe(1);
    expect(mainSyms!.actions[0].name).toBe('Go north');
  });

  it('delact {name} creates action reference', () => {
    const tree = parser.parse('test://cb-delact', `# main
act {Go north}: pl 'hi'
delact {Go north}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-delact');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.actionRefs.size).toBe(1);
    expect(mainSyms!.actionRefs.get('go north')!.name).toBe('Go north');
  });

  // ── Variable references from string args ──

  it('sortarr {name} creates variable reference', () => {
    const tree = parser.parse('test://cb-sortarr', `# main
arr[0] = 3
sortarr {arr}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-sortarr');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.variables.has('arr')).toBe(true);
    expect(mainSyms!.variables.get('arr')!.references.length).toBe(2);
  });

  it('killvar {name} creates variable reference', () => {
    const tree = parser.parse('test://cb-killvar', `# main
x = 1
killvar {x}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-killvar');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.variables.get('x')!.references.length).toBe(2);
  });

  it('arrsize({name}) creates variable reference', () => {
    const tree = parser.parse('test://cb-arrsize', `# main
arr[0] = 1
pl arrsize({$arr})
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-arrsize');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.variables.get('arr')!.references.length).toBe(2);
  });

  // ── Range positions (braces excluded from range) ──

  it('positions code block ref range inside braces', () => {
    const tree = parser.parse('test://cb-pos', `# main
gosub {myLoc}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-pos');
    const mainSyms = symbols.getLocation('main');
    const ref = [...mainSyms!.locationRefs.values()][0];
    // gosub {myLoc}
    // 0123456789...
    // brace at col 6, content starts at col 7
    expect(ref.references[0].column).toBe(7);
    expect(ref.references[0].endColumn).toBe(12);
  });

  it('trims whitespace inside braces for location refs', () => {
    const tree = parser.parse('test://cb-trim', `# main
gosub {  room1  }
---
# room1
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-trim');
    const refs = symbols.findLocationReferences('room1');
    expect(refs).toHaveLength(2);

    const mainSyms = symbols.getLocation('main');
    const gosubRef = [...mainSyms!.locationRefs.values()][0];
    // gosub {  room1  }
    // 0123456789...
    // brace at 6, 2 spaces, then 'room1' at col 9
    expect(gosubRef.references[0].column).toBe(9);
    expect(gosubRef.references[0].endColumn).toBe(14);
  });

  it('preserves spaces inside braces for object names (exact)', () => {
    const tree = parser.parse('test://cb-objspace', `# main
addobj {  Sword  }
addobj {Sword}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://cb-objspace');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.objectRefs.get('  sword  ')!.name).toBe('  Sword  ');
    expect(mainSyms!.objectRefs.get('sword')!.name).toBe('Sword');
  });
});

describe('compound expressions ignored — no refs from string+string or string+$var', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  // ── Location references ──

  it('goto with string concatenation does NOT create location ref', () => {
    const tree = parser.parse('test://expr-goto', `# main
goto 'a' + 'b'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-goto');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.locationRefs.size).toBe(0);
  });

  it('gosub with string + $var does NOT create location ref', () => {
    const tree = parser.parse('test://expr-gosub', `# main
gosub 'prefix' + $suffix
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-gosub');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.locationRefs.size).toBe(0);
  });

  it('func() with concatenation does NOT create location ref', () => {
    const tree = parser.parse('test://expr-func', `# main
x = func('a' + 'b')
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-func');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.locationRefs.size).toBe(0);
  });

  // ── Label references ──

  it('jump with concatenation does NOT create label ref', () => {
    const tree = parser.parse('test://expr-jump', `# main
:start
jump 'sta' + 'rt'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-jump');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.labelRefs.size).toBe(0);
  });

  // ── Object references ──

  it('addobj with concatenation does NOT create object ref', () => {
    const tree = parser.parse('test://expr-addobj', `# main
addobj 'Magic ' + 'Sword'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-addobj');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.objectRefs.size).toBe(0);
  });

  // ── Action references ──

  it('delact with concatenation does NOT create action ref', () => {
    const tree = parser.parse('test://expr-delact', `# main
act 'Go north': pl 'hi'
delact 'Go ' + 'north'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-delact');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.actionRefs.size).toBe(0);
  });

  // ── Variable references from string args ──

  it('sortarr with concatenation does NOT create variable ref from string', () => {
    const tree = parser.parse('test://expr-sortarr', `# main
arr[0] = 3
sortarr '$' + 'arr'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-sortarr');
    const mainSyms = symbols.getLocation('main');
    // arr variable exists from the assignment, but sortarr should NOT add a string-based ref
    expect(mainSyms!.variables.get('arr')!.references.length).toBe(1); // only the assignment
  });

  it('arrsize() with concatenation does NOT create variable ref from string', () => {
    const tree = parser.parse('test://expr-arrsize', `# main
arr[0] = 1
pl arrsize('$' + 'arr')
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-arrsize');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.variables.get('arr')!.references.length).toBe(1);
  });

  // ── Plain strings still work ──

  it('goto with plain string still creates location ref', () => {
    const tree = parser.parse('test://expr-ok', `# main
goto 'target'
---
# target
pl 'hi'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://expr-ok');
    const refs = symbols.findLocationReferences('target');
    expect(refs).toHaveLength(2);
  });
});

describe('extractSymbols — additional edge cases', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('should extract location ref from @@name user call statement', () => {
    const tree = parser.parse('test://edge-usercall2', `# main
@@target
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-usercall2');
    const refs = symbols.findLocationReferences('target');
    expect(refs).toHaveLength(1);
  });

  it('should NOT extract refs for dynamic (non-string) arguments', () => {
    const tree = parser.parse('test://edge-dynamic', `# main
gosub $locName
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-dynamic');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.locationRefs.size).toBe(0);
  });

  it('should NOT create location refs for non-location statements', () => {
    const tree = parser.parse('test://edge-nonloc', `# main
openqst 'game.qsp'
dyneval 'x = 1'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-nonloc');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.locationRefs.size).toBe(0);
  });

  it('should skip label after & statement separator', () => {
    const tree = parser.parse('test://edge-amp-label', `# main
x = 1 & :fake
:real
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-amp-label');
    const locSyms = symbols.getLocation('main');
    expect(locSyms!.getLabel('real', 0)).toBeDefined();
    expect(locSyms!.getLabel('fake', 0)).toBeUndefined();
  });

  it('should extract label as the first statement in a &-chain', () => {
    // `:loop` is the head of the chain, no `&` precedes it — it IS a real
    // label that a `jump 'loop'` would target at runtime.
    const tree = parser.parse('test://edge-amp-head', `# main
:loop & pl 'a'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-amp-head');
    const locSyms = symbols.getLocation('main');
    expect(locSyms!.getLabel('loop', 0)).toBeDefined();
  });

  it('should skip a label that is not at the start of a line (inline-form body)', () => {
    // QSP runtime only recognizes labels when they start a line. The
    // implementation uses a uniform "previous sibling ends on the same
    // line" check, so every inline form (if/elseif/else/loop/act) and
    // the after-`&` case are handled the same way — the inline `act`
    // case below is representative.
    const tree = parser.parse('test://edge-inline-label', `# main
act 'go': :foo & end
:real
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-inline-label');
    const locSyms = symbols.getLocation('main');
    // The inline-act `:foo` must not appear in any namespace bucket.
    for (const [, bucket] of locSyms!.labels) {
      expect(bucket.has('foo')).toBe(false);
    }
    // The line-start `:real` label is still extracted normally.
    expect(locSyms!.getLabel('real', 0)).toBeDefined();
  });

  it('should handle empty location body', () => {
    const tree = parser.parse('test://edge-empty', `# empty
---
`);
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
    const { symbols } = extractSymbols(tree!, 'test://edge-empty');
    expect(symbols.locationDefs.has('empty')).toBe(true);
    const locSyms = symbols.getLocation('empty');
    expect(locSyms!.variables.size).toBe(0);
    expect(locSyms!.labels.size).toBe(0);
    expect(locSyms!.actions.length).toBe(0);
  });

  it('should return null from findSymbolAtPosition for untracked position', () => {
    const tree = parser.parse('test://edge-nopos', `# test
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-nopos');
    expect(symbols.findSymbolAtPosition(99, 0)).toBeNull();
  });

  it('should NOT extract refs for act with dynamic (non-string) name', () => {
    const tree = parser.parse('test://edge-dynact', `# main
act $actName: pl 'dynamic'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-dynact');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms).toBeDefined();
    // Action should still be tracked (with the expression text as name),
    // but it should NOT be a string-literal name
    expect(mainSyms!.actions.length).toBe(1);
  });

  it('should NOT extract object ref for obj with dynamic argument', () => {
    const tree = parser.parse('test://edge-dynobj', `# main
addobj $objName
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-dynobj');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.objectRefs.size).toBe(0);
  });

  it('should NOT extract location ref for loc with dynamic argument', () => {
    const tree = parser.parse('test://edge-dynloc', `# main
if loc $locName: pl 'exists'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://edge-dynloc');
    const mainSyms = symbols.getLocation('main');
    expect(mainSyms!.locationRefs.size).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findSymbolAtPosition — scoped search
// ──────────────────────────────────────────────────────────────────────

describe('extractSymbols — variable refs from statement/function string args', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function getVars(code: string, locName = 'main'): Map<string, { def: boolean; refCount: number }> {
    const tree = parser.parse('test://varref', code)!;
    const { symbols } = extractSymbols(tree, 'test://varref');
    const locSyms = symbols.getLocation(locName);
    const result = new Map<string, { def: boolean; refCount: number }>();
    if (locSyms) {
      for (const [key, sym] of locSyms.variables) {
        result.set(key, { def: !!sym.definition, refCount: sym.references.length });
      }
    }
    return result;
  }

  // ── Statements that define a variable ──

  it('setvar defines a variable', () => {
    const vars = getVars(`# main\nsetvar '$x', 5\n---\n`);
    expect(vars.get('x')?.def).toBe(true);
  });

  it('scanstr defines a variable', () => {
    const vars = getVars(`# main\nscanstr '$result', 'hello world', '\\w+'\n---\n`);
    expect(vars.get('result')?.def).toBe(true);
  });

  it('unpackarr defines a variable', () => {
    const vars = getVars(`# main\nunpackarr 'items', %tup\n---\n`);
    expect(vars.get('items')?.def).toBe(true);
  });

  // ── Statements that reference a variable ──

  it('sortarr references a variable', () => {
    const vars = getVars(`# main\narr[0] = 3\nsortarr 'arr'\n---\n`);
    const v = vars.get('arr');
    expect(v).toBeDefined();
    expect(v!.refCount).toBe(2); // assignment + sortarr
  });

  it('killvar references a variable', () => {
    const vars = getVars(`# main\nx = 1\nkillvar 'x'\n---\n`);
    const v = vars.get('x');
    expect(v).toBeDefined();
    expect(v!.refCount).toBe(2); // assignment + killvar
  });

  it('menu references a variable', () => {
    const vars = getVars(`# main\n$menuItems[0] = 'Option 1'\nmenu '$menuItems'\n---\n`);
    expect(vars.has('menuitems')).toBe(true);
    expect(vars.get('menuitems')!.refCount).toBe(2);
  });

  // ── copyarr: 1st arg = def, 2nd arg = ref ──

  it('copyarr defines first arg and references second arg', () => {
    const vars = getVars(`# main\nsrc[0] = 1\ncopyarr '$dest', '$src'\n---\n`);
    expect(vars.get('dest')?.def).toBe(true);
    expect(vars.get('src')?.def).toBe(true); // assignment is also a def
    expect(vars.get('src')!.refCount).toBe(2); // assignment + copyarr ref
  });

  it('copyarr with paren args', () => {
    const vars = getVars(`# main\ncopyarr('dest', 'src')\n---\n`);
    expect(vars.get('dest')?.def).toBe(true);
    expect(vars.has('src')).toBe(true);
  });

  // ── Functions that reference a variable ──

  it.each([
    ['arrsize', "pl arrsize('$arr')"],
    ['arrpos', "pl arrpos('$arr', 1)"],
    ['arrcomp', "pl arrcomp('$arr', 'pattern')"],
    ['arritem', "pl arritem('$arr', 0)"],
    ['arrtype', "pl arrtype('$arr', 0)"],
    ['arrpack', "pl arrpack('$arr', 0, 1)"],
  ])('%s references a variable', (_func, code) => {
    const vars = getVars(`# main\narr[0] = 1\n${code}\n---\n`);
    expect(vars.get('arr')!.refCount).toBe(2); // assignment + function call
  });

  // ── max/min: single-arg = variable ref, multi-arg = no ref ──

  it.each([
    ['max', "pl max('arr')"],
    ['min', "pl min('$arr')"],
  ])('%s with single arg references a variable', (_func, code) => {
    const vars = getVars(`# main\narr[0] = 5\n${code}\n---\n`);
    expect(vars.get('arr')!.refCount).toBe(2);
  });

  it('max with multiple args does NOT create variable ref', () => {
    const vars = getVars(`# main\npl max(1, 2, 3)\n---\n`);
    // No variable references should be created from numeric args
    expect(vars.size).toBe(0);
  });

  it('min with multiple args does NOT create variable ref', () => {
    const vars = getVars(`# main\nx = 1\ny = 2\npl min(x, y)\n---\n`);
    // x and y are variable_ref nodes, not string args — they should exist
    // but only from direct usage, not from string-arg extraction
    expect(vars.get('x')!.refCount).toBe(2); // assignment + direct use
    expect(vars.get('y')!.refCount).toBe(2);
  });

  // ── Prefix stripping ──

  it('strips $ prefix from variable name in string', () => {
    const vars = getVars(`# main\narrsize('$myVar')\n---\n`);
    expect(vars.has('myvar')).toBe(true);
    expect(vars.has('$myvar')).toBe(false);
  });

  it('strips # prefix from variable name in string', () => {
    const vars = getVars(`# main\narrsize('#counts')\n---\n`);
    expect(vars.has('counts')).toBe(true);
  });

  it('no prefix: variable name used as-is', () => {
    const vars = getVars(`# main\nsortarr 'items'\n---\n`);
    expect(vars.has('items')).toBe(true);
  });

  // ── Type-prefixed function calls ($func, #func, %func) ──

  it.each([
    ['$arrsize', "pl $arrsize('$arr')"],
    ['#arrpos', "pl #arrpos('$arr', 1)"],
    ['$arritem', "pl $arritem('$arr', 0)"],
  ])('%s references a variable', (_func, code) => {
    const vars = getVars(`# main\narr[0] = 1\n${code}\n---\n`);
    expect(vars.get('arr')!.refCount).toBe(2);
  });

  it.each([
    ['$max', "pl $max('$arr')"],
    ['#min', "pl #min('arr')"],
  ])('%s with single arg references a variable', (_func, code) => {
    const vars = getVars(`# main\narr[0] = 5\n${code}\n---\n`);
    expect(vars.get('arr')!.refCount).toBe(2);
  });

  it('$max with multiple args does NOT create variable ref', () => {
    const vars = getVars(`# main\npl $max(1, 2)\n---\n`);
    expect(vars.size).toBe(0);
  });

  // ── Block-level locals with string-arg builtins ──

  it('killvar inside block references block-level local', () => {
    const tree = parser.parse('test://killvar-local', `# main
if 1:
  local x = 5
  killvar 'x'
end
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://killvar-local');
    const loc = symbols.getLocation('main')!;
    // Should find local x, referenced by both assignment and killvar
    const localEntries = [...loc.variables.entries()].filter(([, s]) => s.isLocal && s.nameLower === 'x');
    expect(localEntries).toHaveLength(1);
    expect(localEntries[0][1].references).toHaveLength(2); // def + killvar
  });

  it('arrpos inside block references block-level local', () => {
    const tree = parser.parse('test://arrpos-local', `# main
if 1:
  local arr[0] = 1
  pl arrpos('$arr', 1)
end
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://arrpos-local');
    const loc = symbols.getLocation('main')!;
    const localEntries = [...loc.variables.entries()].filter(([, s]) => s.isLocal && s.nameLower === 'arr');
    expect(localEntries).toHaveLength(1);
    expect(localEntries[0][1].references).toHaveLength(2); // def + arrpos
  });

  it('setvar inside block defines block-level local', () => {
    const tree = parser.parse('test://setvar-local', `# main
if 1:
  local x = 0
  setvar '$x', 42
end
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://setvar-local');
    const loc = symbols.getLocation('main')!;
    const localEntries = [...loc.variables.entries()].filter(([, s]) => s.isLocal && s.nameLower === 'x');
    expect(localEntries).toHaveLength(1);
    expect(localEntries[0][1].references).toHaveLength(2);
  });

  it('copyarr inside block references block-level locals', () => {
    const tree = parser.parse('test://copyarr-local', `# main
if 1:
  local src[0] = 1
  local dst[0] = 0
  copyarr '$dst', '$src'
end
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://copyarr-local');
    const loc = symbols.getLocation('main')!;
    const srcLocal = [...loc.variables.entries()].filter(([, s]) => s.isLocal && s.nameLower === 'src');
    const dstLocal = [...loc.variables.entries()].filter(([, s]) => s.isLocal && s.nameLower === 'dst');
    expect(srcLocal).toHaveLength(1);
    expect(srcLocal[0][1].references).toHaveLength(2); // def + copyarr ref
    expect(dstLocal).toHaveLength(1);
    expect(dstLocal[0][1].references).toHaveLength(2); // def + copyarr def
  });

  it('sortarr inside block references block-level local', () => {
    const tree = parser.parse('test://sortarr-local', `# main
if 1:
  local arr[0] = 3
  sortarr '$arr'
end
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://sortarr-local');
    const loc = symbols.getLocation('main')!;
    const localEntries = [...loc.variables.entries()].filter(([, s]) => s.isLocal && s.nameLower === 'arr');
    expect(localEntries).toHaveLength(1);
    expect(localEntries[0][1].references).toHaveLength(2);
  });
});

