import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Connection, TextDocuments } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { FileChangeType } from 'vscode-languageserver';
import { excludeMatcher, excludeRules, parseIgnoreFile } from '../src/common/projectExclude';
import { fsProvider as nodeFs } from '../src/server/nodeHost';
import { ProjectModeService } from '../src/server/projectMode';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import type { DocumentState } from '../src/server/lspFeatures';
import type { FsProvider } from '../src/server/serverUtils';
import { ALL_DIAGS_OFF, initParser } from './testHelpers';

const matcher = (patterns: string[]) => excludeMatcher({ patterns, source: 'setting' });

describe('projectExclude: patterns', () => {
  it('reads one pattern per line, skipping blank lines, comments and a BOM', () => {
    expect(parseIgnoreFile('﻿# built library\n_export/\r\n\n  drafts  \n#old\n*.bak.qsps\n'))
      .toEqual(['_export/', 'drafts', '*.bak.qsps']);
  });

  it('takes a name without a slash at any depth, with everything inside it', () => {
    const m = matcher(['_export', '*.bak.qsps']);
    expect(m.file('_export/lib.qsps')).toBe(true);
    expect(m.file('src/_export/deep/lib.qsps')).toBe(true);
    expect(m.file('src/game.bak.qsps')).toBe(true);
    expect(m.file('src/game.qsps')).toBe(false);
    expect(m.file('my_export/lib.qsps')).toBe(false);
    expect(m.dir('src/_export')).toBe(true);
    expect(m.dir('src')).toBe(false);
  });

  it('takes a pattern with a slash as a path from the workspace folder', () => {
    const m = matcher(['/_export', 'src/old/*.qsps', '**/drafts/**']);
    expect(m.file('_export/lib.qsps')).toBe(true);
    expect(m.file('src/_export/lib.qsps')).toBe(false);
    expect(m.file('src/old/a.qsps')).toBe(true);
    expect(m.file('old/a.qsps')).toBe(false);
    expect(m.file('a/b/drafts/c.qsps')).toBe(true);
  });

  it('compares names case-insensitively, and takes backslashes', () => {
    expect(matcher(['_Export/']).file('_EXPORT\\lib.qsps')).toBe(true);
  });

  it('always skips the folders no project keeps sources in, Cyrillic names untouched', () => {
    const m = matcher([]);
    expect(m.file('.export/lib.qsps')).toBe(true);
    expect(m.file('node_modules/x/a.qsps')).toBe(true);
    expect(m.file('out/game.qsps')).toBe(true);
    expect(m.file('.hidden.qsps')).toBe(false);
    expect(m.file('Локации/старт.qsps')).toBe(false);
    expect(matcher(['Черновики']).file('Черновики/старт.qsps')).toBe(true);
  });

  it('takes the .qspignore alone when there is one, even empty; else the setting', () => {
    expect(excludeRules('_export\n', ['drafts'])).toEqual({ patterns: ['_export'], source: 'ignoreFile' });
    expect(excludeRules('', ['drafts'])).toEqual({ patterns: [], source: 'ignoreFile' });
    expect(excludeRules(undefined, ['drafts', '', 3])).toEqual({ patterns: ['drafts'], source: 'setting' });
    expect(excludeRules(undefined, undefined)).toEqual({ patterns: [], source: 'none' });
  });
});

describe('projectExclude: the Node walk', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsp-exclude-'));
    for (const rel of ['game.qsps', 'src/a.qsps', '_export/lib.qsps', '.export/lib.qsps', 'src/_export/b.qsps']) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), '# x\n---\n');
    }
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const found = async (exclude?: ReturnType<typeof matcher>) => {
    const files: string[] = [];
    for await (const f of nodeFs.findFiles(dir, ['.qsps'], exclude)) files.push(path.relative(dir, f).split(path.sep).join('/'));
    return files.sort();
  };

  it('skips dot folders without patterns, as before', async () => {
    expect(await found()).toEqual(['_export/lib.qsps', 'game.qsps', 'src/_export/b.qsps', 'src/a.qsps']);
  });

  it('leaves out what the patterns name', async () => {
    expect(await found(matcher(['_export/']))).toEqual(['game.qsps', 'src/a.qsps']);
  });
});

describe('projectExclude: project mode', () => {
  const tsParser = new QspTreeSitterParser();
  beforeAll(async () => { await initParser(tsParser); });

  const connection = {
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    sendDiagnostics: () => {},
  } as unknown as Connection;

  function fakeFs(files: Map<string, string>): FsProvider {
    return {
      async readFile(p: string) {
        const text = files.get(p);
        if (text === undefined) throw new Error(`ENOENT: ${p}`);
        return text;
      },
      async *findFiles(dir: string, extensions: string[], exclude) {
        for (const p of files.keys()) {
          if (!p.startsWith(`${dir}/`) || !extensions.some(e => p.endsWith(e))) continue;
          if (exclude?.file(p.slice(dir.length + 1))) continue;
          yield p;
        }
      },
      pathToUri: (p: string) => `file://${p}`,
      uriToPath: (uri: string) => uri.replace('file://', ''),
    };
  }

  async function load(files: Map<string, string>, setting: string[] = [], open: string[] = []) {
    const documents = {
      get: (uri: string) => (open.includes(uri) ? { uri, getText: () => '# o\n---\n' } : undefined),
      all: () => open.map(uri => ({ uri, getText: () => '# o\n---\n', version: 1, languageId: 'qsp' })),
    } as unknown as TextDocuments<TextDocument>;
    const project = new ProjectModeService(connection, documents, new Map<string, DocumentState>(), tsParser);
    project.workspaceFolders = ['/proj'];
    project.workspaceFolderUris = ['file:///proj'];
    project.excludeSetting = setting;
    await project.init(fakeFs(files), 'utf8', () => new Map(), () => [], ALL_DIAGS_OFF);
    return project;
  }

  const game = () => new Map([
    ['/proj/game.qsps', '# start\n---\n'],
    ['/proj/_export/lib.qsps', '# start\n---\n'],
    ['/proj/drafts/d.qsps', '# draft\n---\n'],
  ]);

  it('leaves out what .qspignore names, open files included, and ignores the setting then', async () => {
    const files = game();
    files.set('/proj/.qspignore', '_export/\n');
    const project = await load(files, ['drafts'], ['file:///proj/_export/lib.qsps']);
    expect([...project.projectFileUris].sort()).toEqual(['file:///proj/drafts/d.qsps', 'file:///proj/game.qsps']);
    expect(project.isExcluded('file:///proj/_export/lib.qsps')).toBe(true);
    expect(project.isExcluded('file:///elsewhere/_export/lib.qsps')).toBe(false);
    expect(project.isIgnoreFile('file:///proj/.qspignore')).toBe(true);
    expect(project.isIgnoreFile('file:///proj/src/.qspignore')).toBe(false);
  });

  it('follows the setting when there is no .qspignore', async () => {
    const project = await load(game(), ['_export', 'drafts/']);
    expect([...project.projectFileUris]).toEqual(['file:///proj/game.qsps']);
  });

  it('keeps a file written into a left-out folder out, and drops one that a change leaves out', async () => {
    const files = game();
    const project = await load(files, ['_export']);
    files.set('/proj/_export/new.qsps', '# start\n---\n');
    await project.handleWatchedFileChanges(
      [{ uri: 'file:///proj/_export/new.qsps', type: FileChangeType.Created }],
      fakeFs(files), 'utf8', ALL_DIAGS_OFF, () => new Map(), () => [],
    );
    expect(project.projectFileUris.has('file:///proj/_export/new.qsps')).toBe(false);

    project.projectFileUris.add('file:///proj/_export/lib.qsps');
    await project.handleWatchedFileChanges(
      [{ uri: 'file:///proj/_export/lib.qsps', type: FileChangeType.Changed }],
      fakeFs(files), 'utf8', ALL_DIAGS_OFF, () => new Map(), () => [],
    );
    expect(project.projectFileUris.has('file:///proj/_export/lib.qsps')).toBe(false);
  });
});
