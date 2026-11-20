import { defaultRecurrence } from '@tracker/core';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newTaskForm } from '../tasks/task-form.js';
import { TASK_DRAFT_KEY, useTaskDraftStore } from './task-draft.js';

const form = () => ({
  ...newTaskForm('2026-11-01', 'm1'),
  title: 'Car insurance renews',
  recurrence: defaultRecurrence('yearly'),
});

/** A page load: a new Pinia, while sessionStorage stays. */
function reload() {
  setActivePinia(createPinia());
  return useTaskDraftStore();
}

beforeEach(() => {
  sessionStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => vi.restoreAllMocks());

describe('task draft store', () => {
  it('hands the draft over once', () => {
    const store = useTaskDraftStore();
    store.set(form());
    expect(store.take()).toEqual(form());
    expect(store.take()).toBeNull();
    expect(sessionStorage.getItem(TASK_DRAFT_KEY)).toBeNull();
  });

  it('survives a full page load, and is taken once afterwards', () => {
    useTaskDraftStore().set(form());

    const afterReload = reload();
    expect(afterReload.take()).toEqual(form());
    expect(reload().take()).toBeNull();
  });

  it('works from memory when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const store = useTaskDraftStore();
    store.set(form());
    expect(store.take()).toEqual(form());
    expect(reload().take()).toBeNull();
  });

  it.each(['not json{', 'null', '42', '{"title":1}', '{"title":"x"}'])(
    'ignores stored garbage %s',
    (raw) => {
      sessionStorage.setItem(TASK_DRAFT_KEY, raw);
      expect(useTaskDraftStore().take()).toBeNull();
      expect(sessionStorage.getItem(TASK_DRAFT_KEY)).toBeNull();
    },
  );
});
