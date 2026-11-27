import { describe, expect, it, vi } from 'vitest';
import { RecentPreference } from './sidebarPrefs';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe('whether the sidebar shows Recent', () => {
  it('shows it unless hidden on this device, and keeps the choice', () => {
    const storage = memoryStorage();
    const preference = new RecentPreference({ storage: () => storage });
    expect(preference.getShown()).toBe(true);
    const listener = vi.fn();
    preference.subscribe(listener);
    preference.setShown(false);
    expect(preference.getShown()).toBe(false);
    expect(storage.getItem('cgw-recent')).toBe('hidden');
    expect(listener).toHaveBeenCalledTimes(1);
    preference.setShown(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(new RecentPreference({ storage: () => storage }).getShown()).toBe(false);
    preference.setShown(true);
    expect(storage.getItem('cgw-recent')).toBeNull();
  });

  it('shows it when storage cannot be read, and still changes for this page', () => {
    const broken = () => {
      throw new Error('blocked');
    };
    const preference = new RecentPreference({ storage: broken });
    expect(preference.getShown()).toBe(true);
    preference.setShown(false);
    expect(preference.getShown()).toBe(false);
  });

  it("follows another tab's change", () => {
    const storage = memoryStorage();
    const events = new EventTarget();
    const preference = new RecentPreference({
      storage: () => storage,
      events: events as unknown as Window,
    });
    const listener = vi.fn();
    const stop = preference.subscribe(listener);
    storage.setItem('cgw-recent', 'hidden');
    events.dispatchEvent(Object.assign(new Event('storage'), { key: 'cgw-recent' }));
    expect(preference.getShown()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    events.dispatchEvent(Object.assign(new Event('storage'), { key: 'cgw-theme' }));
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    storage.removeItem('cgw-recent');
    events.dispatchEvent(Object.assign(new Event('storage'), { key: 'cgw-recent' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
