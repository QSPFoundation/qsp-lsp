import { describe, it, expect } from 'vitest';
import {
  pickPlayerExecutable, classifyPlayerPath, listPlayers, findPlayer, playerArguments, DEFAULT_PLAYER_ARGS,
} from '../src/common/playerExecutable';

describe('pickPlayerExecutable', () => {
  it('takes a plain path on every platform, trimmed', () => {
    expect(pickPlayerExecutable('  tools/qspgui.exe ', 'win32')).toBe('tools/qspgui.exe');
    expect(pickPlayerExecutable('tools/qspgui.exe', 'linux')).toBe('tools/qspgui.exe');
  });

  it('takes the entry for the current platform from an object', () => {
    const value = { win32: 'C:\\QSP\\qspgui.exe', linux: '/usr/bin/qspgui' };
    expect(pickPlayerExecutable(value, 'win32')).toBe('C:\\QSP\\qspgui.exe');
    expect(pickPlayerExecutable(value, 'linux')).toBe('/usr/bin/qspgui');
  });

  it('returns undefined so the caller falls back to the setting', () => {
    expect(pickPlayerExecutable({ win32: 'qspgui.exe' }, 'darwin')).toBeUndefined();
    expect(pickPlayerExecutable(undefined, 'linux')).toBeUndefined();
    expect(pickPlayerExecutable('   ', 'linux')).toBeUndefined();
    expect(pickPlayerExecutable(42, 'linux')).toBeUndefined();
    expect(pickPlayerExecutable(['qspgui'], 'linux')).toBeUndefined();
    expect(pickPlayerExecutable({ linux: 7 }, 'linux')).toBeUndefined();
  });
});

describe('classifyPlayerPath', () => {
  it('recognises absolute POSIX, Windows drive and UNC paths', () => {
    expect(classifyPlayerPath('/usr/bin/qspgui')).toBe('absolute');
    expect(classifyPlayerPath('C:\\QSP\\qspgui.exe')).toBe('absolute');
    expect(classifyPlayerPath('d:/qsp/qspgui.exe')).toBe('absolute');
    expect(classifyPlayerPath('\\\\server\\share\\qspgui.exe')).toBe('absolute');
  });

  it('treats a bare name as a command looked up on PATH', () => {
    expect(classifyPlayerPath('qspgui')).toBe('command');
    expect(classifyPlayerPath('qspgui.exe')).toBe('command');
  });

  it('treats a path with a separator as relative to the workspace', () => {
    expect(classifyPlayerPath('tools/qspgui.exe')).toBe('relative');
    expect(classifyPlayerPath('./qspgui')).toBe('relative');
    expect(classifyPlayerPath('..\\player\\qspgui.exe')).toBe('relative');
    expect(classifyPlayerPath('плеер/qspgui')).toBe('relative');
  });
});

describe('listPlayers', () => {
  const players = [
    { name: 'qspgui', executable: { win32: '../tools/qspgui/bin/qspgui.exe', linux: '../tools/qspgui/AppRun' } },
    {
      name: 'qSpider',
      executable: { win32: '../tools/qspider/qSpider.exe', linux: '../tools/qspider/AppRun' },
      args: ['--file', '${game}'],
    },
  ];

  it('lists `players` in order, the default first, each with its path for this OS', () => {
    expect(listPlayers({ players }, 'linux')).toEqual([
      { name: 'qspgui', executable: '../tools/qspgui/AppRun', args: DEFAULT_PLAYER_ARGS },
      { name: 'qSpider', executable: '../tools/qspider/AppRun', args: ['--file', '${game}'] },
    ]);
  });

  it('takes `players` over `playerExecutable`, and `playerExecutable` alone without it', () => {
    expect(listPlayers({ players, playerExecutable: 'other' }, 'win32').map(p => p.name)).toEqual(['qspgui', 'qSpider']);
    expect(listPlayers({ playerExecutable: 'C:\\QSP\\qspgui.exe' }, 'win32'))
      .toEqual([{ name: 'qspgui', executable: 'C:\\QSP\\qspgui.exe', args: DEFAULT_PLAYER_ARGS }]);
    expect(listPlayers(undefined, 'linux')).toEqual([]);
    expect(listPlayers({}, 'linux')).toEqual([]);
  });

  it('leaves out a player with no path for this OS or with broken arguments', () => {
    expect(listPlayers({ players }, 'darwin')).toEqual([]);
    const broken = [
      { name: 'a', executable: '/bin/a', args: '--file ${game}' },
      { name: 'b', executable: '/bin/b', args: [1] },
      { name: 'c' },
      'd',
      null,
      { executable: '/opt/Плеер/qspgui.sh' },
    ];
    expect(listPlayers({ players: broken }, 'linux')).toEqual([{ name: 'qspgui', executable: '/opt/Плеер/qspgui.sh', args: DEFAULT_PLAYER_ARGS }]);
  });
});

describe('findPlayer and playerArguments', () => {
  it('find a player by name whatever its case, and put the game in its arguments', () => {
    const players = listPlayers({ players: [{ name: 'qSpider', executable: 'qspider', args: ['--file', '${game}', 'x${game}'] }] }, 'linux');
    expect(findPlayer(players, ' QSPIDER ')).toBe(players[0]);
    expect(findPlayer(players, 'qspgui')).toBeUndefined();
    expect(playerArguments(players[0].args, '/home/игрок/game.qsp')).toEqual(['--file', '/home/игрок/game.qsp', 'x/home/игрок/game.qsp']);
    expect(playerArguments(DEFAULT_PLAYER_ARGS, 'C:\\a b\\g.qsp')).toEqual(['C:\\a b\\g.qsp']);
  });
});
