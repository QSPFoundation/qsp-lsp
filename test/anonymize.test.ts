/**
 * Anonymized code for crash reports (src/parser/anonymize.ts).
 *
 * Why
 * ───
 * - Users attach it for games whose text they can't share: no name,
 *   string, comment or number of the game may survive.
 * - It exists to reproduce analysis failures, so the structure (blocks,
 *   calls, assignments, line numbers) must survive and still parse, and
 *   one name must always map to one pseudonym. Strings and comments keep
 *   what the analysis reads in them, their text masked: quotes, braces,
 *   markup, `exec:` links, `<<…>>` interpolations (a location's comments
 *   and interpolated keys were what made one crash, and dropping them
 *   made the anonymized code analyse fine).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { anonymizeCode } from '../src/parser/anonymize';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

const CODE = [
  'Текст перед локацией с сюжетом',
  '# Тайная_комната',
  '! Секретный комментарий автора',
  "local $пароль = 'шифр_семь'",
  '$сокровище = "Золотой <<$пароль>> ключ"',
  'сила = сила + 42',
  "$меню = {",
  "\tpl 'Сундук открыт'",
  "\tif сила > 10: dynamic $меню",
  "}",
  'dynamic $меню',
  "gs 'Подземелье', $пароль",
  "@Подземелье(3)",
  ':метка_сна',
  "if args[0] = 7: jump 'метка_сна'",
  "act 'Открыть_сундук': addobj 'Проклятый_амулет'",
  '--- Тайная_комната ---',
  '# Подземелье',
  "*pl 'Скрытый текст сюжета'",
  `*pl '<a href="exec:gt ''Тайная_комната''">Вниз</a>' & ! Заметка {о том} 'что' <<сделать>>`,
  "gt 'Тайная_комната'",
  '--- Подземелье ---',
  '',
].join('\n');

const SECRETS = ['Текст', 'сюжет', 'Тайная', 'Секретный', 'пароль', 'шифр', 'семь', 'сокровище', 'Золотой', 'ключ',
  'сила', 'меню', 'Сундук', 'Подземелье', 'метка', 'сна', 'Открыть', 'Проклятый', 'амулет', 'Скрытый', 'Вниз', 'Заметка', 'сделать', '42', '10'];

function types(tree: ReturnType<QspTreeSitterParser['parseOnce']>): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (n: NonNullable<typeof tree>['rootNode']) => {
    if (n.isNamed) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    for (const c of n.children) walk(c);
  };
  walk(tree!.rootNode);
  return counts;
}

describe('anonymizeCode', () => {
  it('leaves nothing of the game in the code', () => {
    const tree = parser.parseOnce(CODE)!;
    const { text } = anonymizeCode(tree, CODE);
    tree.delete();
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  it('keeps the structure and the line numbers, and still parses', () => {
    const tree = parser.parseOnce(CODE)!;
    const { text } = anonymizeCode(tree, CODE);
    const again = parser.parseOnce(text)!;
    expect(again.rootNode.hasError).toBe(false);
    expect(text.split('\n')).toHaveLength(CODE.split('\n').length);
    const before = types(tree), after = types(again);
    for (const t of ['location_block', 'code_block', 'if_inline', 'act_inline', 'local_statement', 'assignment_statement', 'user_func_call', 'label_statement',
      'comment_statement', 'raw_code_block', 'raw_string', 'string_interpolation']) {
      expect(after.get(t), t).toBe(before.get(t));
    }
    tree.delete();
    again.delete();
  });

  it('maps each name to one pseudonym, and reports what they stand for', () => {
    const tree = parser.parseOnce(CODE)!;
    const { text, names } = anonymizeCode(tree, CODE);
    tree.delete();
    expect(text).toContain('# loc_0001');
    expect(text).toContain("gt 'loc_0001'");
    expect(text).toContain("gs 'loc_0002'");
    expect(text).toContain('@loc_0002(0)');
    expect(names.loc_0001).toBe('Тайная_комната');
    const menu = Object.keys(names).find(p => names[p] === 'меню')!;
    expect(text.match(new RegExp(`\\$${menu}\\b`, 'g'))).toHaveLength(3);
    // Builtin variables and keywords stay as written.
    expect(text).toContain('if args[0] = 0:');
    expect(text).toContain('dynamic $');
  });

  it('masks the text of strings and comments, keeping what the analysis reads in them', () => {
    const tree = parser.parseOnce(CODE)!;
    const { text, names } = anonymizeCode(tree, CODE);
    tree.delete();
    const password = Object.keys(names).find(p => names[p] === 'пароль')!;
    expect(text).toContain(`"xxxxxxx <<$${password}>> xxxx"`);
    expect(text).toContain(`'<x xxxx="exec:xx ''xxxxxxxxxxxxxx''">xxxx</x>'`);
    expect(text).toContain("! xxxxxxx {x xxx} 'xxx' <<xxxxxxx>>");
  });

  it('uses the pseudonyms it is given for locations', () => {
    const tree = parser.parseOnce(CODE)!;
    const { text, names } = anonymizeCode(tree, CODE, { locations: new Map([['подземелье', 'f01_l0007']]) });
    tree.delete();
    expect(text).toContain('# f01_l0007');
    expect(text).toContain("gs 'f01_l0007'");
    expect(names.f01_l0007).toBeUndefined();
  });
});
