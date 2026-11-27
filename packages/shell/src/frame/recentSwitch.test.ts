import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { applyRecent } = await import('../sidebarPrefs');
const { recentHidden, setRecentShown } = await import('./recentSwitch');

const attribute = () => document.documentElement.dataset.cgwRecent;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.cgwRecent;
});
afterEach(() => vi.restoreAllMocks());

describe('whether the sidebar shows Recent', () => {
  it('shows it unless hidden on this device, and keeps the choice', () => {
    applyRecent();
    expect(recentHidden()).toBe(false);
    expect(attribute()).toBeUndefined();
    setRecentShown(false);
    expect(recentHidden()).toBe(true);
    expect(attribute()).toBe('hidden');
    expect(localStorage.getItem('cgw-recent')).toBe('hidden');
    // The next start reads it.
    delete document.documentElement.dataset.cgwRecent;
    applyRecent();
    expect(attribute()).toBe('hidden');
    setRecentShown(true);
    expect(attribute()).toBeUndefined();
    expect(localStorage.getItem('cgw-recent')).toBeNull();
  });

  it('shows it when storage cannot be read, and still changes for this page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    applyRecent();
    expect(recentHidden()).toBe(false);
    expect(attribute()).toBeUndefined();
    setRecentShown(false);
    expect(attribute()).toBe('hidden');
  });
});
