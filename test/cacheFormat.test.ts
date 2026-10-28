/**
 * The analysis cache's format (src/server/cacheFormat.ts).
 *
 * Why
 * ───
 * - A stored value must come back whole: contents, the order of Maps, Sets
 *   and fields, shared objects shared, typed arrays, numbers exactly
 *   (-0, NaN, past 2^31), any string (Cyrillic, half a surrogate pair).
 * - What it can't hold must fail when written, not come back changed.
 * - Bytes it didn't write must fail when read: the cache counts that as a miss.
 * - Parts encoded apart (by worker threads) are stored as they are, and read
 *   back as the array of their values.
 * - A file's analysis read back must be the one that was stored.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { decodeValue, encodeParts, encodeValue } from '../src/server/cacheFormat';
import { analyzeFileText } from '../src/server/fileAnalysis';
import { QspTreeSitterParser, buildLocationIndex, reviveDocumentSymbols } from '../src/parser';
import { initParser } from './testHelpers';

const roundTrip = <T>(value: T): T => decodeValue(encodeValue(value)) as T;

describe('encodeValue and decodeValue', () => {
  it('keep every value, the order of Maps, Sets and fields, and shared objects', () => {
    const uri = 'file:///game/main.qsps';
    const loc = { uri, line: 1, column: 2, endLine: 1, endColumn: 7, kind: 'write' };
    const first = new Map<string, unknown[]>([['счёт', [loc]], ['имя', []]]);
    const second = new Map<unknown, unknown>([['имя', { uri }], ['счёт', loc], [loc, 'by object'], [7, null]]);
    const names = new Set<unknown>(['b', 'а', loc]);
    const value = {
      first, second, names,
      refs: [loc, loc, 'write'],
      long: Array.from({ length: 300 }, (_, i) => (i % 3 ? i * 1000 : loc)),
      numbers: [0, -0, 1, 127, 128, -1, -128, 2 ** 31, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 60, 0.5, -1e-9, NaN, Infinity, -Infinity],
      strings: ['', 'Прихожая', '😀', 'a\uD800b', '\uDC00', 'x'.repeat(10_000)],
      flags: { yes: true, no: false, none: null, missing: undefined },
      empty: {}, emptyArray: [] as unknown[], emptyMap: new Map(), emptySet: new Set(),
      tokens: new Uint32Array([1, 2, 3, 0xffffffff]),
      slice: new Float64Array([0.25, -2, 3]).subarray(1),
      bytes: new Uint8Array([5, 6]),
      odd: { 'with space': 1, 'кириллица': 2, '"quoted"': 3, '2': 'index', constructor: 'field' },
    };
    const back = roundTrip(value);
    expect(back).toEqual(value);
    expect(Object.is(back.numbers[1], -0)).toBe(true);
    expect([...back.second.keys()].slice(0, 2)).toEqual(['имя', 'счёт']);
    expect([...back.names].slice(0, 2)).toEqual(['b', 'а']);
    expect(Object.keys(back.odd)).toEqual(Object.keys(value.odd));
    expect('missing' in back.flags).toBe(true);
    const shared = back.first.get('счёт')![0];
    for (const same of [back.refs[0], back.refs[1], back.long[0], back.second.get('счёт'), [...back.second.keys()][2], [...back.names][2]]) {
      expect(same).toBe(shared);
    }
    expect(back.second.get(shared)).toBe('by object');
    expect(back.tokens).toBeInstanceOf(Uint32Array);
    expect(back.slice).toEqual(new Float64Array([-2, 3]));
  });

  it('keeps shapes past the ones a byte names, and an own `__proto__` field', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ [`k${i}`]: i, shared: 'v' }));
    const proto = JSON.parse('{"__proto__": 1, "a": 2}') as object;
    const back = roundTrip({ many, proto, again: proto });
    expect(back.many).toEqual(many);
    expect(Object.getPrototypeOf(back.proto)).toBe(Object.prototype);
    expect(Object.entries(back.proto)).toEqual([['__proto__', 1], ['a', 2]]);
    expect(back.again).toBe(back.proto);
  });

  it('stores class instances and objects without a prototype as plain objects', () => {
    class Point { constructor(readonly x: number, readonly y: number) {} get sum() { return this.x + this.y; } }
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    const back = roundTrip({ point: new Point(1, 2), bare }) as unknown as { point: object; bare: object };
    expect(Object.getPrototypeOf(back.point)).toBe(Object.prototype);
    expect(back.point).toEqual({ x: 1, y: 2 });
    expect(back.bare).toEqual({ a: 1 });
  });

  it('refuses what it can\'t hold', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const list: unknown[] = [];
    list.push(new Map([['me', list]]));
    for (const value of [cyclic, list, { f: () => 1 }, [Symbol('s')], 1n, new Date(0), new Error('e'), /re/, new DataView(new ArrayBuffer(1))]) {
      expect(() => encodeValue(value)).toThrow();
    }
    let deep: unknown = 'bottom';
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(roundTrip(deep)).toEqual(deep);
  });

  it('refuses bytes it didn\'t write, cut short or with anything added', () => {
    const bytes = encodeValue({ names: ['Прихожая', 'Кухня'], map: new Map([[1, 'один']]), tokens: new Uint32Array([1, 2]) });
    expect(() => decodeValue(new Uint8Array(0))).toThrow();
    expect(() => decodeValue(new Uint8Array([99, 0, 0, 0]))).toThrow();
    for (let n = 1; n < bytes.length; n++) expect(() => decodeValue(bytes.subarray(0, n))).toThrow();
    expect(() => decodeValue(Uint8Array.from([...bytes, 0]))).toThrow();
  });
});

describe('encodeParts', () => {
  it('reads back as the array of the values encoded apart', () => {
    const shared = { name: 'Прихожая' };
    const parts = [{ a: shared, b: shared }, ['Кухня', new Map([[1, 'один']])], 7];
    const back = decodeValue(encodeParts(parts.map(encodeValue))) as [typeof parts[0], unknown, number];
    expect(back).toEqual(parts);
    expect(back[0].a).toBe(back[0].b);
    expect(decodeValue(encodeParts([]))).toEqual([]);
    const bytes = encodeParts(parts.map(encodeValue));
    for (const n of [1, 5, bytes.length - 1]) expect(() => decodeValue(bytes.subarray(0, n))).toThrow();
  });
});

describe('a file\'s analysis in the cache\'s format', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  it('comes back as it was stored, with its symbols working', () => {
    const uri = 'file:///игра/главная.qsps';
    const text = [
      "# начало\nlocal $имя = 'гость'\nx = 1 & y = x + 1\nact 'дальше': gs 'вторая', $имя, x\n",
      "$код = {\n  *pl 'внутри'\n  z = 3\n}\ndynamic $код\nif x = 1:\n  :метка\n  jump 'метка'\nend\n--- начало ---\n",
      "# вторая\n*pl $args[0] + <<x>>\naddobj 'ключ'\n*pl '<a href=\"exec:gt ''начало''\">назад</a>'\nif\n--- вторая ---\n",
    ].join('\n');
    const analysis = analyzeFileText(parser, uri, text, buildLocationIndex(text), true);
    expect(analysis.syntaxErrors.length).toBeGreaterThan(0);
    const back = roundTrip(analysis);
    expect(back).toEqual(analysis);
    const symbols = reviveDocumentSymbols(back.symbols)!;
    expect(symbols.getLocation('Вторая')).toBeDefined();
    expect(symbols.findVariableReferences('x').length).toBeGreaterThan(2);
    expect(symbols.findVariableReferences('x')).toEqual(analysis.symbols.findVariableReferences('x'));
    // The URI is written once, however many positions name it.
    expect(Buffer.from(encodeValue(analysis)).toString('utf8').split(uri).length - 1).toBe(1);
  });
});
