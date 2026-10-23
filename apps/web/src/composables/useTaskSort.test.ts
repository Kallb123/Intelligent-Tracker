import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_SORT_STORAGE_KEY, useTaskSort } from './useTaskSort.js';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('useTaskSort', () => {
  it('defaults to next due', () => {
    expect(useTaskSort().value).toBe('due');
  });

  it('starts from the stored choice', () => {
    localStorage.setItem(TASK_SORT_STORAGE_KEY, 'priority');
    expect(useTaskSort().value).toBe('priority');
  });

  it('ignores a stored value that is not a sort', () => {
    localStorage.setItem(TASK_SORT_STORAGE_KEY, 'alphabetical');
    expect(useTaskSort().value).toBe('due');
  });

  it('writes the choice back when it changes', async () => {
    const sort = useTaskSort();
    sort.value = 'newest';
    await nextTick();
    expect(localStorage.getItem(TASK_SORT_STORAGE_KEY)).toBe('newest');
  });

  it('still works when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const sort = useTaskSort();
    expect(sort.value).toBe('due');
    sort.value = 'title';
    await nextTick();
    expect(sort.value).toBe('title');
  });
});
