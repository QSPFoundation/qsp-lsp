// ── The analysis cache's format (Node) ───────────────────────────────
//
// What the analysis cache stores (nodeCache.ts), and what a worker thread
// hands over (analysisWorker.ts): plain objects, arrays, Maps, Sets, typed
// arrays, strings, numbers, booleans, undefined and null, an object met twice
// kept as one. `v8.serialize` writes every key of every object and every
// string in full (178 MB for a 12.8 M-character file's analysis), and what
// `v8.deserialize` makes of it takes as long again to make as compact as a
// fresh analysis. Here:
// - each string is written once, in a table, and each list of keys (a
//   shape) once: an object is its shape's number and then its values;
// - whole numbers are varints, and the commonest values take one byte;
// - an object met again is the number it got the first time.
// The same analysis takes 35 MB, read back in 0.4 s instead of 2.5 s, as
// compact as a fresh one: equal strings are one string, every object is
// made by a literal of its keys (so they're all inside it), and arrays are
// as long as their contents.
//
// A cycle can't be stored: an object is made after its values. The bytes
// are read where they were written (the user's cache folder, a thread of
// the same process), so typed arrays keep that machine's byte order.

/** The first byte; another one is never read. */
const VERSION = 1;

// The tag byte in front of each value.
const UNDEFINED = 0;
const NULL = 1;
const FALSE = 2;
const TRUE = 3;
/** Then the number, a varint. */
const UINT = 4;
/** Then the number's negation, a varint. */
const NEGATIVE = 5;
/** Then the 8 bytes of a float64. */
const FLOAT = 6;
/** Then the string's number in the table. */
const STRING = 7;
/** Then the shape's number and a value per key. */
const OBJECT = 8;
/** Then the length and the items. */
const ARRAY = 9;
/** Then the size, and a key and a value per entry. */
const MAP = 10;
/** Then the size and the items. */
const SET = 11;
/** Then the kind (TYPED_ARRAYS), the length in bytes, and the bytes. */
const TYPED = 12;
/** Then the number of an object already read: they're numbered as they're finished. */
const SEEN = 13;
/** Then the length and the bytes of a value encoded on its own (see encodeParts). */
const ENCODED = 14;
/** 0x40 to 0x7f: an object of shape 0 to 63, then its values. */
const SHAPE_TAG = 0x40;
/** 0x80 to 0xff: the whole number 0 to 127. */
const SMALL_UINT_TAG = 0x80;

const TYPED_ARRAYS = [
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array,
];

// Deeper than any analysis nests; past it the value is taken for a cycle.
const MAX_DEPTH = 1000;

// A string with half a surrogate pair can't be UTF-8: it's kept in UTF-16.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * `value` in the cache's format, in a buffer of its own (so a worker can
 * hand it over without a copy). Throws on what the format can't hold: a
 * cycle, a function, a symbol, a bigint, or an object of a class it doesn't
 * know (a Date, an Error); other class instances are stored as plain objects
 * of their own fields, as `v8.serialize` does.
 */
export function encodeValue(value: unknown): Uint8Array {
  return new Encoder().encode(value);
}

/**
 * Values already encoded (by worker threads, a part of a file each) as one
 * value, the array of them, without decoding them.
 */
export function encodeParts(parts: readonly Uint8Array[]): Uint8Array {
  // Sized up front: the main thread joins a large file's parts.
  const out = new ByteWriter(parts.reduce((n, part) => n + part.length + 9, 16));
  out.byte(VERSION);
  out.uint(0); // strings: each part has its own
  out.uint(0); // shapes
  out.byte(ARRAY);
  out.uint(parts.length);
  for (const part of parts) {
    out.byte(ENCODED);
    out.uint(part.length);
    out.raw(part);
  }
  return out.bytes.subarray(0, out.pos);
}

/**
 * The value `encodeValue` (or `encodeParts`) stored in `bytes`. Throws when
 * they aren't something those wrote (the caller counts that as a cache miss).
 */
export function decodeValue(bytes: Uint8Array): unknown {
  if (bytes[0] !== VERSION) throw new Error('not an analysis cache entry');
  const reader = new Reader(bytes);
  reader.readTables();
  const value = reader.read();
  if (reader.pos !== bytes.length) throw new Error('analysis cache entry of the wrong length');
  return value;
}

// ── Writing ──────────────────────────────────────────────────────────

class ByteWriter {
  bytes: Uint8Array;
  pos = 0;

  constructor(size = 64 * 1024) {
    this.bytes = new Uint8Array(size);
  }

  reserve(n: number): void {
    if (this.pos + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.pos + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.pos));
    this.bytes = grown;
  }

  byte(b: number): void {
    this.reserve(1);
    this.bytes[this.pos++] = b;
  }

  uint(n: number): void {
    this.reserve(8);
    while (n >= 0x80) {
      this.bytes[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.bytes[this.pos++] = n;
  }

  raw(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.pos);
    this.pos += bytes.length;
  }
}

// The shapes met so far, as a tree of their keys in order: finding an
// object's shape allocates nothing.
interface ShapeNode { next: Map<string, ShapeNode>; index: number }

class Encoder {
  private readonly body = new ByteWriter();
  private readonly stringIndex = new Map<string, number>();
  private readonly strings: string[] = [];
  private readonly shapeTree: ShapeNode = { next: new Map(), index: -1 };
  private readonly shapes: string[][] = [];
  private readonly finished = new Map<object, number>();
  private depth = 0;

  encode(value: unknown): Uint8Array {
    this.write(value);
    const shapeKeys = this.shapes.map(keys => keys.map(k => this.string(k)));
    const head = new ByteWriter();
    head.byte(VERSION);
    head.uint(this.strings.length);
    for (const s of this.strings) {
      const utf16 = LONE_SURROGATE.test(s);
      const bytes = Buffer.from(s, utf16 ? 'utf16le' : 'utf8');
      head.uint(bytes.length * 2 + (utf16 ? 1 : 0));
      head.raw(bytes);
    }
    head.uint(shapeKeys.length);
    for (const keys of shapeKeys) {
      head.uint(keys.length);
      for (const k of keys) head.uint(k);
    }
    const out = new Uint8Array(head.pos + this.body.pos);
    out.set(head.bytes.subarray(0, head.pos));
    out.set(this.body.bytes.subarray(0, this.body.pos), head.pos);
    return out;
  }

  private string(s: string): number {
    let index = this.stringIndex.get(s);
    if (index === undefined) {
      index = this.strings.length;
      this.strings.push(s);
      this.stringIndex.set(s, index);
    }
    return index;
  }

  private write(v: unknown): void {
    const out = this.body;
    switch (typeof v) {
      case 'undefined': out.byte(UNDEFINED); return;
      case 'boolean': out.byte(v ? TRUE : FALSE); return;
      case 'string': out.byte(STRING); out.uint(this.string(v)); return;
      case 'number':
        // -0 isn't 0 to `Object.is`: it goes as a float.
        if (Number.isSafeInteger(v) && (v !== 0 || 1 / v > 0)) {
          if (v >= 0 && v < 0x80) out.byte(SMALL_UINT_TAG + v);
          else if (v >= 0) { out.byte(UINT); out.uint(v); } else { out.byte(NEGATIVE); out.uint(-v); }
        } else {
          out.byte(FLOAT);
          out.reserve(8);
          new DataView(out.bytes.buffer).setFloat64(out.pos, v, true);
          out.pos += 8;
        }
        return;
      case 'object':
        if (v === null) out.byte(NULL);
        else this.writeObject(v);
        return;
      default:
        throw new Error(`the analysis cache can't store a ${typeof v}`);
    }
  }

  private writeObject(v: object): void {
    const out = this.body;
    const number = this.finished.get(v);
    if (number !== undefined) {
      out.byte(SEEN);
      out.uint(number);
      return;
    }
    if (++this.depth > MAX_DEPTH) throw new Error('the analysis cache can\'t store a cycle, or values nested this deep');
    const proto = Object.getPrototypeOf(v) as object | null;
    if (proto === Object.prototype) this.writeFields(v);
    else if (Array.isArray(v)) {
      out.byte(ARRAY);
      out.uint(v.length);
      for (let i = 0; i < v.length; i++) this.write(v[i]);
    } else if (v instanceof Map) {
      out.byte(MAP);
      out.uint(v.size);
      v.forEach((item, key) => { this.write(key); this.write(item); });
    } else if (v instanceof Set) {
      out.byte(SET);
      out.uint(v.size);
      v.forEach(item => this.write(item));
    } else if (ArrayBuffer.isView(v)) {
      const kind = TYPED_ARRAYS.findIndex(T => v instanceof T);
      if (kind < 0) throw new Error(`the analysis cache can't store a ${v.constructor.name}`);
      out.byte(TYPED);
      out.byte(kind);
      out.uint(v.byteLength);
      out.raw(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    } else if (proto === null || Object.prototype.toString.call(v) === '[object Object]') {
      this.writeFields(v);
    } else {
      throw new Error(`the analysis cache can't store a ${Object.prototype.toString.call(v).slice(8, -1)}`);
    }
    this.depth--;
    this.finished.set(v, this.finished.size);
  }

  // An object's own fields, as a plain object.
  private writeFields(v: object): void {
    const out = this.body;
    let node = this.shapeTree;
    for (const key in v) {
      let next = node.next.get(key);
      if (next === undefined) {
        next = { next: new Map(), index: -1 };
        node.next.set(key, next);
      }
      node = next;
    }
    if (node.index < 0) {
      node.index = this.shapes.length;
      const keys: string[] = [];
      for (const key in v) keys.push(key);
      this.shapes.push(keys);
    }
    if (node.index < SMALL_UINT_TAG - SHAPE_TAG) out.byte(SHAPE_TAG + node.index);
    else { out.byte(OBJECT); out.uint(node.index); }
    const fields = v as Record<string, unknown>;
    for (const key in fields) this.write(fields[key]);
  }
}

// ── Reading ──────────────────────────────────────────────────────────

/** Makes an object or array of the values read next, and numbers it. */
type Maker = (reader: Reader) => object;

// One maker per shape, kept across entries: a project load reads thousands
// with the same few dozen shapes. Generated, because only an object literal
// that names its keys gets them all inside the object.
const makers = new Map<string, Maker>();
const MAX_MAKERS = 1000;

function makerOf(keys: readonly string[]): Maker {
  const id = JSON.stringify(keys);
  let make = makers.get(id);
  if (make) return make;
  if (makers.size >= MAX_MAKERS) {
    return (reader) => {
      const o: Record<string, unknown> = {};
      for (const key of keys) Object.defineProperty(o, key, { value: reader.read(), enumerable: true, writable: true, configurable: true });
      reader.objects.push(o);
      return o;
    };
  }
  // A literal reads its values in order. `__proto__:` in a literal would set
  // the prototype; a computed key makes a field of that name.
  const fields = keys.map(k => `${k === '__proto__' ? '["__proto__"]' : JSON.stringify(k)}: r.read()`).join(', ');
  make = new Function('r', `const o = { ${fields} }; r.objects.push(o); return o;`) as Maker;
  makers.set(id, make);
  return make;
}

// Short arrays from a literal too: exactly as long as their contents.
const SHORT_ARRAY = 8;
const arrayMakers = Array.from({ length: SHORT_ARRAY + 1 }, (_, n) => new Function(
  'r', `const a = [${Array.from({ length: n }, () => 'r.read()').join(', ')}]; r.objects.push(a); return a;`,
) as Maker);

class Reader {
  pos = 1;
  /** Every object read so far, in the order they were finished. */
  readonly objects: object[] = [];
  private strings: string[] = [];
  private shapes: Maker[] = [];
  private readonly view: DataView;
  private readonly buffer: Buffer;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  readTables(): void {
    const strings = new Array<string>(this.count(1));
    for (let i = 0; i < strings.length; i++) {
      const header = this.uint();
      const length = Math.floor(header / 2);
      if (length > this.bytes.length - this.pos) throw new Error('analysis cache entry cut short');
      strings[i] = this.buffer.toString(header % 2 ? 'utf16le' : 'utf8', this.pos, this.pos + length);
      this.pos += length;
    }
    this.strings = strings;
    const shapes = new Array<Maker>(this.count(1));
    for (let i = 0; i < shapes.length; i++) {
      const keys = new Array<string>(this.count(1));
      for (let j = 0; j < keys.length; j++) keys[j] = this.string();
      shapes[i] = makerOf(keys);
    }
    this.shapes = shapes;
  }

  read(): unknown {
    const tag = this.bytes[this.pos++];
    if (tag >= SMALL_UINT_TAG) return tag - SMALL_UINT_TAG;
    if (tag >= SHAPE_TAG) return this.shape(tag - SHAPE_TAG)(this);
    switch (tag) {
      case UNDEFINED: return undefined;
      case NULL: return null;
      case FALSE: return false;
      case TRUE: return true;
      case UINT: return this.uint();
      case NEGATIVE: return -this.uint();
      case FLOAT: {
        const v = this.view.getFloat64(this.pos, true);
        this.pos += 8;
        return v;
      }
      case STRING: return this.string();
      case OBJECT: return this.shape(this.uint())(this);
      case ARRAY: {
        const length = this.count(1);
        if (length <= SHORT_ARRAY) return arrayMakers[length](this);
        const a = new Array<unknown>(length);
        for (let i = 0; i < length; i++) a[i] = this.read();
        this.objects.push(a);
        return a;
      }
      case MAP: {
        const size = this.count(2);
        const m = new Map<unknown, unknown>();
        for (let i = 0; i < size; i++) {
          const key = this.read();
          m.set(key, this.read());
        }
        this.objects.push(m);
        return m;
      }
      case SET: {
        const size = this.count(1);
        const s = new Set<unknown>();
        for (let i = 0; i < size; i++) s.add(this.read());
        this.objects.push(s);
        return s;
      }
      case TYPED: {
        const T = TYPED_ARRAYS[this.bytes[this.pos++]];
        const length = this.count(1);
        if (!T || length % T.BYTES_PER_ELEMENT !== 0) throw new Error('bad typed array in an analysis cache entry');
        // A copy: its own buffer, aligned for T.
        const copy = new Uint8Array(length);
        copy.set(this.bytes.subarray(this.pos, this.pos + length));
        const a = new T(copy.buffer);
        this.pos += length;
        this.objects.push(a);
        return a;
      }
      case ENCODED: {
        const length = this.count(1);
        const value = decodeValue(this.bytes.subarray(this.pos, this.pos + length));
        this.pos += length;
        return value;
      }
      case SEEN: {
        const o = this.objects[this.uint()];
        if (o === undefined) throw new Error('bad reference in an analysis cache entry');
        return o;
      }
      default:
        throw new Error('bad tag in an analysis cache entry');
    }
  }

  private uint(): number {
    const bytes = this.bytes;
    let b = bytes[this.pos++];
    if (b < 0x80) return b;
    let n = b & 0x7f;
    let scale = 0x80;
    do {
      b = bytes[this.pos++];
      n += (b & 0x7f) * scale;
      scale *= 0x80;
    } while (b >= 0x80);
    return n;
  }

  // A number of things that take at least `bytesEach` each: more than the
  // bytes left means a broken entry, not an array to allocate.
  private count(bytesEach: number): number {
    const n = this.uint();
    if (!(n * bytesEach <= this.bytes.length - this.pos)) throw new Error('analysis cache entry cut short');
    return n;
  }

  private string(): string {
    const s = this.strings[this.uint()];
    if (s === undefined) throw new Error('bad string in an analysis cache entry');
    return s;
  }

  private shape(index: number): Maker {
    const make = this.shapes[index];
    if (make === undefined) throw new Error('bad shape in an analysis cache entry');
    return make;
  }
}
