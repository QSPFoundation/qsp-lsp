/**
 * The jump graph (`qsp/jumpGraph`): who jumps to or calls whom.
 *
 * Why
 * ───
 * - Every kind of jump and call is an edge of its own type, with the
 *   first few places it is written and a count; several `gt 'b'` in one
 *   location are one edge. A big game has tens of thousands of jump
 *   sites, and listing them all made replies tens of megabytes.
 * - A target no file defines still shows, as a missing node.
 * - `loc 'name'` only checks that a location exists: not an edge.
 * - A target that isn't a string literal (`gt $next`, `gt 'room_' + $n`,
 *   an interpolated string) has no name to be a location ref under; it is
 *   kept separately so the graph can show a jump to an unknown target,
 *   including from `exec:` links and from files parsed per location.
 * - Such a jump also gets "possible" edges to the locations its
 *   variables' known values name, and leaves the unknown target only
 *   when those values may not be all; a jump that could go almost
 *   anywhere stays unknown rather than fanning out.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { buildLocationIndex, DocumentSymbols, extractSymbols } from '../src/parser';
import { buildJumpGraph, formatDynamicJumpStats, newDynamicJumpStats, type JumpGraphSource } from '../src/server/jumpGraph';
import { initParser, parseAndExtract } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

function source(code: string, uri = 'file:///game/main.qsps'): JumpGraphSource {
  const { symbols } = parseAndExtract(parser, code, uri);
  return { uri, symbols, locationIndex: buildLocationIndex(code) };
}

const edgeList = (code: string) =>
  buildJumpGraph([source(code)]).edges.map(e => `${e.from}->${e.to}:${e.callType}(${e.siteCount})`).sort();

describe('buildJumpGraph: exact edges', () => {
  it('types each jump and call', () => {
    const code = [
      '# a',
      "gt 'b'",
      "xgt 'b'",
      "gosub 'c'",
      "x = func('d')",
      '@e',
      "$t = desc('b')",
      '---',
      '# b', '---', '# c', '---', '# d', '---', '# e', '---',
    ].join('\n') + '\n';
    expect(edgeList(code)).toEqual([
      'a->b:desc(1)', 'a->b:goto(2)', 'a->c:gosub(1)', 'a->d:func(1)', 'a->e:func(1)',
    ]);
  });

  it('lists the sites of an edge, with their line and text (the file is the location\'s own)', () => {
    const graph = buildJumpGraph([source("# a\ngt 'B'\nif x: gt 'b'\n---\n# B\n---\n")]);
    expect(graph.edges).toEqual([{
      from: 'a', to: 'b', callType: 'goto', kind: 'exact', siteCount: 2,
      sites: [
        { line: 1, text: "gt 'B'" },
        { line: 2, text: "gt 'b'" },
      ],
    }]);
  });

  it('keeps only the earliest three sites, counts them all, and shortens long ones', () => {
    const long = `gt 'b', '${'x'.repeat(200)}'`;
    const graph = buildJumpGraph([
      source(`# a\n${long}\ngt 'b'\ngt 'b'\ngt 'b'\n---\n# b\n---\n`, 'file:///game/z.qsps'),
      source("# c\n---\n# a2\n---\n", 'file:///game/a.qsps'),
    ]);
    const [edge] = graph.edges;
    expect(edge.siteCount).toBe(4);
    expect(edge.sites.map(x => x.line)).toEqual([1, 2, 3]);
    expect(edge.sites[0].text).toHaveLength(120);
    expect(edge.sites[0].text.endsWith('…')).toBe(true);
  });

  it('shows a target nobody defines as a missing node', () => {
    const graph = buildJumpGraph([source("# a\ngt 'nowhere'\n---\n")]);
    expect(graph.nodes).toEqual(expect.arrayContaining([{ name: 'nowhere', missing: true }]));
  });

  it('does not count `loc` (an existence check) as a jump', () => {
    expect(edgeList("# a\nif loc('b'): *pl 1\n---\n# b\n---\n")).toEqual([]);
  });

  it('names the file of a site in another file than the location\'s first definition', () => {
    const graph = buildJumpGraph([
      source("# a\n---\n# b\n---\n", 'file:///game/main.qsps'),
      source("# a\ngt 'b'\n---\n", 'file:///game/copy.qsps'),
    ]);
    expect(graph.edges[0].sites).toEqual([{ uri: 'file:///game/copy.qsps', line: 1, text: "gt 'b'" }]);
  });

  it('connects locations across files, Cyrillic names included', () => {
    const graph = buildJumpGraph([
      source("# старт\ngt 'Лес'\n---\n", 'file:///game/main.qsps'),
      source('# лес\n---\n', 'file:///game/forest.qsps'),
    ]);
    expect(graph.edges.map(e => `${e.from}->${e.to}`)).toEqual(['старт->лес']);
    expect(graph.nodes).toEqual(expect.arrayContaining([{ name: 'лес', uri: 'file:///game/forest.qsps', line: 0 }]));
  });
});

describe('buildJumpGraph: targets that are not literals', () => {
  it('lists them as unresolved per call type, with the target expressions', () => {
    const code = "# a\ngt $next\ngosub 'room_' + $n\nx = func($f)\ngt '<<$where>>'\ngt $next\n---\n";
    const graph = buildJumpGraph([source(code)]);
    expect(graph.edges).toEqual([]);
    expect(graph.unresolved.map(u => [u.callType, u.exprs, u.sites.map(x => x.line), u.siteCount])).toEqual([
      ['goto', ['$next', "'<<$where>>'"], [1, 4, 5], 3],
      ['gosub', ["'room_' + $n"], [2], 1],
      ['func', ['$f'], [3], 1],
    ]);
    expect(graph.unresolved[1].sites[0].text).toBe("gosub 'room_' + $n");
  });

  it('keeps them from exec: links', () => {
    const code = `# a\n*pl '<a href="exec:gt $next">go</a>'\n---\n`;
    const uri = 'file:///game/main.qsps';
    const tree = parser.parseOnce(code)!;
    // exec: bodies are analyzed only with a re-parse callback, as the server passes.
    const { symbols } = extractSymbols(tree, uri, (t) => parser.parseOnce(t));
    const graph = buildJumpGraph([{ uri, symbols, locationIndex: buildLocationIndex(code) }]);
    expect(graph.unresolved.map(u => u.exprs)).toEqual([['$next']]);
    expect(graph.unresolved[0].sites[0].line).toBe(1);
  });

  it('keeps their lines when a location is merged in from a per-location parse', () => {
    // How large files are analyzed: each location parsed alone, then shifted into the file.
    const locText = '# far\n*pl 1\ngt $next\n---\n';
    const tree = parser.parseOnce(locText)!;
    const { symbols: alone } = extractSymbols(tree, 'file:///game/big.qsps');
    tree.delete();
    const file = new DocumentSymbols('file:///game/big.qsps');
    const [locSyms] = alone.locations.values();
    file.addLocationFrom('far', { uri: 'file:///game/big.qsps', line: 100, column: 2, endLine: 100, endColumn: 5 }, locSyms, 100);
    expect(file.getLocation('far')!.dynamicLocationRefs[0].loc.line).toBe(102);
  });
});

describe('buildJumpGraph: possible targets of dynamic jumps', () => {
  const rooms = (names: string[]) => names.map(n => `# ${n}\n---`).join('\n');
  const possible = (code: string) => {
    const graph = buildJumpGraph([source(code + '\n')]);
    return {
      edges: graph.edges.filter(e => e.kind === 'possible').map(e => `${e.from}->${e.to}:${e.callType} via ${e.via!.join(',')}`).sort(),
      unresolved: graph.unresolved.map(u => `${u.from}:${u.exprs.join(',')}`),
    };
  };

  it('follows a variable to every value written to it, and is then fully resolved', () => {
    const code = `# a\ngt $next\n---\n# b\n$next = 'Hall'\n---\n# c\n$next = "kitchen"\n---\n${rooms(['hall', 'kitchen'])}`;
    expect(possible(code)).toEqual({ edges: ['a->hall:goto via $next', 'a->kitchen:goto via $next'], unresolved: [] });
  });

  it('stays unresolved as well when some value is unknown or names no location', () => {
    const code = `# a\ngt $next\n---\n# b\n$next = 'hall'\n$next = $mid($s, 1, 2)\n---\n${rooms(['hall'])}`;
    expect(possible(code)).toEqual({ edges: ['a->hall:goto via $next'], unresolved: ['a:$next'] });
    const typo = `# a\ngt $next\n---\n# b\n$next = 'hal'\n---\n${rooms(['hall'])}`;
    expect(possible(typo)).toEqual({ edges: [], unresolved: ['a:$next'] });
  });

  it('builds names from a prefix and a number, interpolation and iif', () => {
    const code = [
      "# a\nif x: n = 1 else n = 2\ngt 'room_' + n\ngs \"room_<<m>>\"\ngt iif(x, 'hall', 'room_3')\n---",
      '# b\nm = 3\n---',
      rooms(['room_1', 'room_2', 'room_3', 'hall']),
    ].join('\n');
    expect(possible(code).edges).toEqual([
      "a->hall:goto via iif(x, 'hall', 'room_3')",
      "a->room_1:goto via 'room_' + n",
      "a->room_2:goto via 'room_' + n",
      'a->room_3:gosub via "room_<<m>>"',
      "a->room_3:goto via iif(x, 'hall', 'room_3')",
    ]);
    expect(possible(code).unresolved).toEqual([]);
  });

  it('matches an unknown part against location names, but not too many of them', () => {
    const few = `# a\ngt 'room_' + $mid($s, 1, 2)\n---\n${rooms(['room_1', 'room_2', 'hall'])}`;
    expect(possible(few)).toEqual({ edges: ["a->room_1:goto via 'room_' + $mid($s, 1, 2)", "a->room_2:goto via 'room_' + $mid($s, 1, 2)"], unresolved: ["a:'room_' + $mid($s, 1, 2)"] });
    const many = `# a\ngt 'room_' + $mid($s, 1, 2)\n---\n${rooms(Array.from({ length: 30 }, (_, i) => `room_${i}`))}`;
    expect(possible(many).edges).toEqual([]);
  });

  it('follows chains, and values built in the location that writes them', () => {
    const code = `# a\ngt $a\n---\n# b\n$a = $b\n---\n# c\nk = 2\n$b = 'room_' + k\n---\n${rooms(['room_2'])}`;
    expect(possible(code)).toEqual({ edges: ['a->room_2:goto via $a'], unresolved: [] });
  });

  it('takes a local variable\'s values from its own location only', () => {
    const code = `# a\nlocal $t = 'hall'\ngt $t\n---\n# b\n$t = 'kitchen'\ngt $t\n---\n${rooms(['hall', 'kitchen'])}`;
    expect(possible(code).edges).toEqual(['a->hall:goto via $t', 'b->kitchen:goto via $t']);
  });

  it('ignores case and Cyrillic in names, and drops a possible edge an exact one already shows', () => {
    const code = `# a\ngt $Куда\ngt 'зал'\ngs $Куда\n---\n# b\n$куда = 'ЗАЛ'\n---\n${rooms(['Зал'])}`;
    const graph = buildJumpGraph([source(code + '\n')]);
    expect(graph.edges.map(e => `${e.to}:${e.callType}:${e.kind}`).sort()).toEqual(['зал:gosub:possible', 'зал:goto:exact']);
    expect(graph.unresolved).toEqual([]);
  });

  it('caps the combinations of several variables', () => {
    const writes = (v: string) => Array.from({ length: 10 }, (_, i) => `${v} = ${i}`).join('\n');
    const code = `# a\ngt 'r' + x + '_' + y\n---\n# b\n${writes('x')}\n${writes('y')}\n---\n${rooms(['r1_1', 'r2_5'])}`;
    const r = possible(code);
    // 100 combinations: one variable is given up on, and the rest still find both rooms.
    expect(r.edges.map(e => e.split(' ')[0])).toEqual(['a->r1_1:goto', 'a->r2_5:goto']);
    expect(r.unresolved).toHaveLength(1);
  });

  it('knows $curloc: the location the code is in', () => {
    const code = `# a\n$back = $curloc\ngt 'b'\n---\n# b\ngt $back\ngt $curloc\n---`;
    const graph = buildJumpGraph([source(code + '\n')]);
    // `gt $curloc` in b is resolved (to b itself) and draws no loop.
    expect(graph.edges.map(e => `${e.from}->${e.to}:${e.kind}`).sort()).toEqual(['a->b:exact', 'b->a:possible']);
    expect(graph.unresolved).toEqual([]);
  });

  it('takes $args from the arguments at the location\'s static calls', () => {
    const code = [
      "# a\ngs 'go', 'hall'\n@go('Kitchen')\nx = func('go', 'cellar', 1)\n---",
      '# go\ngt $args[0]\n---',
      rooms(['hall', 'kitchen', 'cellar']),
    ].join('\n');
    expect(possible(code)).toEqual({ edges: ['go->cellar:goto via $args[0]', 'go->hall:goto via $args[0]', 'go->kitchen:goto via $args[0]'], unresolved: [] });
    const unknownArg = code.replace("x = func('go', 'cellar', 1)", "gs 'go', $mid($s, 1, 2)");
    expect(possible(unknownArg).unresolved).toEqual(['go:$args[0]']);
  });

  it('follows func() to what the called location puts in result', () => {
    const code = `# a\ngt func('pick')\n---\n# pick\nif x: $result = 'hall' else $result = 'kitchen'\n---\n${rooms(['hall', 'kitchen'])}`;
    expect(possible(code)).toEqual({ edges: ["a->hall:goto via func('pick')", "a->kitchen:goto via func('pick')"], unresolved: [] });
  });

  it('sums up a "where I came from" variable: written everywhere from $curloc', () => {
    const code = Array.from({ length: 60 }, (_, i) => `# r${i}\n$back = $curloc\ngs 'menu'\n---`).join('\n') + "\n# menu\ngt $back\n---";
    const stats = newDynamicJumpStats();
    buildJumpGraph([source(code + '\n')], stats);
    expect(formatDynamicJumpStats(stats)).toContain('variables they read: v1 1 jumps (60 writes, 51+ values, some from $curloc)');
  });

  it('counts how the dynamic jumps resolved, and why not, without a single name', () => {
    const code = [
      "# a\n$next = 'hall'\ngt $next\ngt $nowhere\ngt $mid($s, 1, 2)\ngt 'room_' + $mid($s, 1, 2)\ngs 'go'\n---",
      '# go\ngt $args[0]\n---',
      rooms(['hall', 'room_1']),
    ].join('\n');
    const stats = newDynamicJumpStats();
    buildJumpGraph([source(code + '\n')], stats);
    expect(stats).toMatchObject({ jumps: 5, resolved: 1, partly: 1, unknown: 3 });
    const line = formatDynamicJumpStats(stats)!;
    expect(line).toBe('[jump graph] 5 dynamic jumps: 1 resolved, 1 in part, 3 unknown'
      + ' · unresolved targets: $args[0] 1, $var 1, call:mid 1, text + call:mid 1'
      + ' · variables they read: v1 1 jumps (1 writes, 0+ values), v2 1 jumps (0 writes, 0+ values)'
      + ' · reasons: call:mid 2, args: unknown at a call 1, no writes 1');
    for (const name of ['hall', 'room_', 'nowhere', 'next', 'go']) expect(line).not.toContain(name);
  });

  it('names no game text for a target broken by a syntax error or calling a function of its own', () => {
    // A comment written after `-` leaves an ERROR node where the operator goes.
    const code = "# a\ngt $curloc - если по квесту или еще как-то нужно\ngt 'r' + \"<<тайна(1)>>\"\ngt \"<<secret(1)>>\"\n---\n";
    const stats = newDynamicJumpStats();
    buildJumpGraph([source(code)], stats);
    const line = formatDynamicJumpStats(stats)!;
    for (const text of ['если', 'квесту', 'как', 'нужно', 'тайна', 'secret']) expect(line).not.toContain(text);
  });

  it('takes the nearest write before the jump in its own location, not every write in the game', () => {
    const others = Array.from({ length: 30 }, (_, i) => `# o${i}\n$loc = 'r${i}'\n---`).join('\n');
    const names = rooms(Array.from({ length: 30 }, (_, i) => `r${i}`));
    const code = `# a\n$loc = 'r1'\n$loc = 'r2'\ngt $loc\nact 'go': $loc = 'r3' & gt $loc\n---\n${others}\n${names}`;
    expect(possible(code)).toEqual({ edges: ['a->r2:goto via $loc', 'a->r3:goto via $loc'], unresolved: [] });
  });

  it('keeps every arm of an if before the jump, back to a write at the jump\'s own level', () => {
    const code = [
      '# a',
      "$loc = 'r0'",
      "$loc = 'r1'",
      'if day:',
      "\t$loc = 'r2'",
      'elseif night:',
      "\t$loc = 'r3'",
      'end',
      'gt $loc',
      '---',
      rooms(['r0', 'r1', 'r2', 'r3']),
    ].join('\n');
    expect(possible(code).edges).toEqual(['a->r1:goto via $loc', 'a->r2:goto via $loc', 'a->r3:goto via $loc']);
  });

  it('reads what the nearest write is built from the same way', () => {
    const others = Array.from({ length: 60 }, (_, i) => `# o${i}\n$dest = 'r${i}'\nn = ${i}\n---`).join('\n');
    const code = `# a\n$dest = 'r1'\n$next = $dest\nn = 7\n$room = 'r' + n\ngs $next\ngt $room\n---\n${others}\n${rooms(['r1', 'r7'])}`;
    expect(possible(code)).toEqual({ edges: ['a->r1:gosub via $next', 'a->r7:goto via $room'], unresolved: [] });
  });

  it('takes the value from the callers when the location itself doesn\'t write it', () => {
    const others = Array.from({ length: 60 }, (_, i) => `# o${i}\n$to = 'r${i}'\n---`).join('\n');
    const code = [
      "# a\n$to = 'r1'\ngt 'road'\n---",
      "# b\nif x:\n\t$to = 'r2'\nend\ngs 'road'\n---",
      '# road\n*pl 1\ngt $to\n---',
      others, rooms(['r1', 'r2']),
    ].join('\n');
    expect(possible(code)).toEqual({ edges: ['road->r1:goto via $to', 'road->r2:goto via $to'], unresolved: [] });
    // A caller that doesn't set it: the jump may also go elsewhere.
    expect(possible(code + "\n# c\ngt 'road'\n---").unresolved).toEqual(['road:$to']);
  });

  it('looks through callers that don\'t write it to their own callers, a few locations back', () => {
    const others = Array.from({ length: 60 }, (_, i) => `# o${i}\n$to = 'r${i}'\n---`).join('\n');
    // старт writes $to; путь and перекрёсток pass through; дорога jumps.
    const chain = [
      "# старт\n$to = 'r1'\ngs 'путь'\n---",
      "# путь\n*pl 1\ngt 'перекрёсток'\n---",
      "# перекрёсток\ngs 'дорога'\n---",
      '# дорога\ngt $to\n---',
      others, rooms(['r1', 'r2']),
    ].join('\n');
    expect(possible(chain)).toEqual({ edges: ['дорога->r1:goto via $to'], unresolved: [] });
    // Branches back meet the same location once, and each writer counts.
    const branches = chain + "\n# другой\n$to = 'r2'\ngt 'перекрёсток'\n---\n# ещё\n$to = 'r2'\ngs 'путь'\n---";
    expect(possible(branches).edges).toEqual(['дорога->r1:goto via $to', 'дорога->r2:goto via $to']);
    // Calls going round in a circle end.
    expect(possible(chain + "\n# круг\ngt 'путь'\n---\n# путь2\ngt 'круг'\n---").edges).toEqual(['дорога->r1:goto via $to']);
  });

  it('stops looking back at a location nothing calls, at a local, and past three locations', () => {
    const others = Array.from({ length: 60 }, (_, i) => `# o${i}\n$to = 'r${i}'\n---`).join('\n');
    const tail = ["# b\ngt 'c'\n---", "# c\ngt 'd'\n---", '# d\ngt $to\n---', others, rooms(['r1'])].join('\n');
    // A writes it three locations back: found, and b is called from nothing else.
    expect(possible("# a\n$to = 'r1'\ngt 'b'\n---\n" + tail)).toEqual({ edges: ['d->r1:goto via $to'], unresolved: [] });
    // b is also entered with nothing set before it.
    expect(possible("# a\n$to = 'r1'\ngt 'b'\n---\n# z\ngt 'b'\n---\n" + tail).unresolved).toEqual(['d:$to']);
    // Four locations back: too far.
    expect(possible("# a0\n$to = 'r1'\ngt 'a'\n---\n# a\ngt 'b'\n---\n" + tail).edges).toEqual([]);
    // A local in between hides the variable from its callers.
    expect(possible("# a\n$to = 'r1'\ngs 'b'\n---\n# b\nlocal $to\ngs 'c'\n---\n# c\ngt 'd'\n---\n# d\ngt $to\n---\n" + others + '\n' + rooms(['r1'])).edges)
      .toEqual([]);
  });
});
