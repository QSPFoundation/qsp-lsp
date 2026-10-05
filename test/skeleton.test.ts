/**
 * Anonymized game skeletons (src/parser/skeleton.ts).
 *
 * Why
 * ───
 * - A skeleton is sent for games whose text can't be shared: no name,
 *   string or comment of the game may survive, in any file.
 * - It exists to reproduce and benchmark the analysis on a game no one
 *   else may see, so the analysis must find in it what it finds in the
 *   game: the same locations, jumps and diagnostics. Names are renamed
 *   word by word with one pseudonym across the game (`'room_' + n` still
 *   names `room_1`), and what the analysis reads in strings and comments
 *   stays: code in `<<…>>` and `exec:` links, `dynamic` lines,
 *   `!@qsp-ignore` directives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { GameSkeleton } from '../src/parser/skeleton';
import { ALL_DIAGS_ON, initParser, runDiagnostics } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

const MAIN = [
  'Текст перед первой локацией',
  '# Тайная_комната',
  '! Секретный комментарий автора',
  '!@qsp-ignore uninitializedVariables: сила',
  "local $пароль = 'шифр_семь'",
  '$сокровище = "Золотой <<$пароль>> ключ"',
  'сила = сила + 42',
  '$меню = {',
  "\tpl 'Сундук открыт'",
  '}',
  '! чтобы открыть: dynamic $меню',
  '$спрятано = { pl 1 }',
  "gs 'Подземелье', 'Тайная'",
  'gt \'Зал_\' + номер',
  '@Подземелье(3)',
  ':метка_сна',
  "if args[0] = 7: jump 'метка_сна'",
  "act 'Открыть сундук': addobj 'Проклятый амулет'",
  "killvar '$пароль'",
  "if $куда = 'Зал' or $куда = 'зал': gt $куда",
  '--- Тайная_комната ---',
  '# Подземелье',
  "*pl 'Скрытый текст сюжета'",
  `*pl '<a href="exec:gt ''Тайная_комната''">Вниз</a>' & ! Заметка`,
  "*pl 'Ключ <<$сокровище[''Подземелье'']>> лежит'",
  "gt 'Тайная_комната'",
  '--- Подземелье ---',
  '',
].join('\n');

const HALLS = [
  '# Зал_1',
  "$куда = 'Зал'",
  'номер = 2',
  '--- Зал_1 ---',
  '# Зал_2',
  "gs 'Тайная_комната'",
  '--- Зал_2 ---',
  '',
].join('\n');

const SECRETS = ['Текст', 'Тайная', 'комната', 'Секретный', 'пароль', 'шифр', 'семь', 'сокровище', 'Золотой', 'ключ',
  'сила', 'меню', 'Сундук', 'спрятано', 'Подземелье', 'Зал', 'номер', 'метка', 'сна', 'Открыть', 'Проклятый', 'амулет',
  'куда', 'Скрытый', 'Вниз', 'Заметка'];

function skeletonOf(files: string[]): { texts: string[]; names: Record<string, string> } {
  const skeleton = new GameSkeleton(t => parser.parseOnce(t));
  const run = <T>(steps: Generator<void, T, undefined>): T => {
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
    }
  };
  for (const f of files) run(skeleton.learnSteps(f));
  const texts = files.map(f => run(skeleton.writeSteps(f)));
  return { texts, names: skeleton.names() };
}

const pseudonymOf = (names: Record<string, string>, word: string) => Object.keys(names).find(p => names[p] === word)!;

describe('GameSkeleton', () => {
  it('leaves nothing of the game in any file', () => {
    const { texts } = skeletonOf([MAIN, HALLS]);
    for (const text of texts) {
      for (const secret of SECRETS) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(text).not.toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('keeps the lines, and the analysis finds the same diagnostics', () => {
    const [main, halls] = skeletonOf([MAIN, HALLS]).texts;
    expect(main.split('\n')).toHaveLength(MAIN.split('\n').length);
    const shape = (code: string) => runDiagnostics(parser, code, ALL_DIAGS_ON).map(d => `${d.range.start.line} ${d.code}`).sort();
    expect(shape(main)).toEqual(shape(MAIN));
    expect(shape(MAIN).length).toBeGreaterThan(0);
    expect(shape(halls)).toEqual(shape(HALLS));
  });

  it('renames word by word with one pseudonym across the game', () => {
    const { texts: [main, halls], names } = skeletonOf([MAIN, HALLS]);
    const hall = pseudonymOf(names, 'Зал');
    const room = `${pseudonymOf(names, 'Тайная')}_${pseudonymOf(names, 'комната')}`;
    expect(main).toContain(`# ${room}`);
    expect(main).toContain(`gt '${hall}_' + ${pseudonymOf(names, 'номер')}`);
    expect(halls).toContain(`# ${hall}_1`);
    expect(halls).toContain(`gs '${room}'`);
    // A string all of whose words are names is a name.
    expect(main).toContain(`gs '${pseudonymOf(names, 'Подземелье')}', '${pseudonymOf(names, 'Тайная')}'`);
    expect(main).toContain(`act '${pseudonymOf(names, 'Открыть')} ${pseudonymOf(names, 'сундук')}':`);
    expect(main).toContain(`killvar '$${pseudonymOf(names, 'пароль')}'`);
    expect(main).toContain(`jump '${pseudonymOf(names, 'метка')}_${pseudonymOf(names, 'сна')}'`);
    // Builtin variables and keywords stay as written; numbers stay.
    expect(main).toContain('if args[0] = 7:');
    expect(main).toContain(' + 42');
  });

  it('gives spellings that differ in case the pseudonym in different cases', () => {
    const { texts: [main], names } = skeletonOf([MAIN, HALLS]);
    const upper = pseudonymOf(names, 'Зал');
    const lower = pseudonymOf(names, 'зал');
    expect(upper).not.toBe(lower);
    expect(upper.toLowerCase()).toBe(lower.toLowerCase());
    expect(main).toContain(`'${upper}' or $${pseudonymOf(names, 'куда')} = '${lower}'`);
  });

  it('masks text, keeping what the analysis reads in strings and comments', () => {
    const { texts: [main], names } = skeletonOf([MAIN, HALLS]);
    const password = pseudonymOf(names, 'пароль');
    const room = `${pseudonymOf(names, 'Тайная')}_${pseudonymOf(names, 'комната')}`;
    expect(main).toContain(`"xxxxxxx <<$${password}>> xxxx"`);
    expect(main).toContain("*pl 'xxxxxxx xxxxx xxxxxx'");
    expect(main).toContain(`'<a href="exec:gt ''${room}''">xxxx</x>' & ! xxxxxxx`);
    expect(main).toContain(`<<$${pseudonymOf(names, 'сокровище')}[''${pseudonymOf(names, 'Подземелье')}'']>>`);
    expect(main).toContain(`!@qsp-ignore uninitializedVariables: ${pseudonymOf(names, 'сила')}`);
    // `dynamic` in a comment keeps a block code (storedBlocks.ts).
    expect(main).toContain(`! xxxxx xxxxxxx: dynamic $${pseudonymOf(names, 'меню')}`);
    expect(main.startsWith('\n# ')).toBe(true);
  });

  it('tells what each pseudonym stands for', () => {
    const { names } = skeletonOf([MAIN, HALLS]);
    expect(Object.values(names)).toContain('Подземелье');
    for (const p of Object.keys(names)) expect(p).toMatch(/^w[a-z]+$/i);
  });
});
