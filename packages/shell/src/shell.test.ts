import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, type Command } from './commands';
import { leavePage, parseRoute, routeHash } from './route';
import { formatShortcut, matchesShortcut, parseShortcut } from './shortcuts';
import { ThemeController, type ThemeEnvironment } from './theme';

const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('shortcuts', () => {
  it('match by event.code, so an Arabic layout gives the same chord', () => {
    // On an Arabic layout KeyK types "ن"; the code is still KeyK.
    expect(matchesShortcut(key('KeyK', { ctrlKey: true }), 'Mod+KeyK', false)).toBe(true);
    expect(matchesShortcut(key('KeyK', { metaKey: true }), 'Mod+KeyK', true)).toBe(true);
    expect(matchesShortcut(key('KeyK', { ctrlKey: true, shiftKey: true }), 'Mod+KeyK', false)).toBe(
      false,
    );
    expect(matchesShortcut(key('KeyK'), 'Mod+KeyK', false)).toBe(false);
    expect(
      matchesShortcut(key('ArrowUp', { altKey: true, shiftKey: true }), 'Alt+Shift+ArrowUp', false),
    ).toBe(true);
  });

  it('are written for people', () => {
    expect(formatShortcut('Mod+Shift+KeyK', false)).toBe('Ctrl+Shift+K');
    expect(formatShortcut('Mod+Backslash', false)).toBe('Ctrl+\\');
    expect(formatShortcut('Alt+Shift+ArrowUp', false)).toBe('Alt+Shift+↑');
    expect(formatShortcut('Mod+KeyK', true)).toBe('⌘K');
  });

  it('refuse unknown modifiers', () => {
    expect(() => parseShortcut('Hyper+KeyK')).toThrow(/Unknown modifier/);
  });
});

describe('command registry', () => {
  const command = (id: string, label: string, extra: Partial<Command> = {}): Command => ({
    id,
    group: 'app',
    label: () => label,
    run: vi.fn(),
    ...extra,
  });

  it('filters by label, then by keyword in either language', () => {
    const registry = new CommandRegistry();
    registry.register(
      command('a', 'Heading 1', { keywords: () => ['title', 'عنوان'] }),
      command('b', 'Bulleted list', { keywords: () => ['list', 'قائمة'] }),
      command('c', 'To-do list'),
    );
    expect(registry.list(null, 'head').map((c) => c.id)).toEqual(['a']);
    expect(registry.list(null, 'list').map((c) => c.id)).toEqual(['b', 'c']);
    expect(registry.list(null, 'قائ').map((c) => c.id)).toEqual(['b']);
    expect(registry.list(null, 'عنو').map((c) => c.id)).toEqual(['a']);
    expect(registry.list(null, '').length).toBe(3);
  });

  it('respects when, and runs shortcuts', async () => {
    const registry = new CommandRegistry<{ ok: boolean }>();
    const run = vi.fn();
    registry.register({
      id: 'x',
      group: 'app',
      label: () => 'X',
      shortcut: 'Mod+KeyK',
      when: (ctx) => ctx.ok,
      run,
    });
    expect(registry.list({ ok: false })).toEqual([]);
    expect(await registry.run('x', { ok: false })).toBe(false);
    const event = { ...key('KeyK', { ctrlKey: true }), preventDefault: vi.fn() };
    expect(registry.handleKey(event as unknown as KeyboardEvent, { ok: true })).toBe(
      !/Mac/.test(globalThis.navigator?.platform ?? ''),
    );
  });

  it('refuses a duplicate id and unregisters', () => {
    const registry = new CommandRegistry();
    const off = registry.register(command('a', 'A'));
    expect(() => registry.register(command('a', 'A'))).toThrow(/twice/);
    off();
    expect(registry.get('a')).toBeUndefined();
  });
});

describe('routes', () => {
  const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  it('round-trip', () => {
    for (const route of [
      { kind: 'home' as const },
      { kind: 'page' as const, pageId: id },
      { kind: 'page' as const, pageId: id, blockId: 'Ab3dEf6hIj9L' },
      { kind: 'trash' as const },
      { kind: 'settings' as const },
    ])
      expect(parseRoute(routeHash(route))).toEqual(route);
  });

  it('ignore what is not a page id', () => {
    expect(parseRoute('#/p/javascript:alert(1)')).toEqual({ kind: 'home' });
    expect(parseRoute(`#/p/${id}/<script>`)).toEqual({ kind: 'page', pageId: id });
  });

  it('leave a page that went only while it is still the one showing', () => {
    const location = { hash: '#/trash' };
    vi.stubGlobal('location', location);
    try {
      // Trashed, and the person went to the trash before the trash was written: they stay there.
      leavePage(id);
      expect(location.hash).toBe('#/trash');
      location.hash = `#/p/${id}`;
      leavePage('0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c');
      expect(location.hash).toBe(`#/p/${id}`);
      leavePage(id);
      expect(location.hash).toBe('#/');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('theme controller', () => {
  function environment(dark: boolean) {
    const store = new Map<string, string>();
    const listeners = new Set<() => void>();
    const env: ThemeEnvironment & { flip: (d: boolean) => void } = {
      systemDark: {
        matches: dark,
        addEventListener: (_: string, l: () => void) => listeners.add(l),
        removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      } as unknown as ThemeEnvironment['systemDark'],
      storage: () =>
        ({
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => store.delete(k),
        }) as unknown as Storage,
      root: { dataset: {} as DOMStringMap },
      flip: (d) => {
        (env.systemDark as { matches: boolean }).matches = d;
        for (const l of listeners) l();
      },
    };
    return env;
  }

  it('follows the system until a theme is picked, and tells the window', () => {
    const env = environment(false);
    const setWindowTheme = vi.fn().mockResolvedValue(undefined);
    const controller = new ThemeController({ setWindowTheme }, env);
    expect(env.root.dataset.cgTheme).toBe('light');
    expect(setWindowTheme).toHaveBeenLastCalledWith(null);
    env.flip(true);
    expect(env.root.dataset.cgTheme).toBe('dark');
    controller.setPreference('light');
    expect(env.root.dataset.cgTheme).toBe('light');
    expect(setWindowTheme).toHaveBeenLastCalledWith('light');
    // A second controller (the next start) reads the saved choice.
    expect(new ThemeController({ setWindowTheme }, env).preference).toBe('light');
  });
});
