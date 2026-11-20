import type { TaskBody } from '@tracker/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_DRAFT_KEY, useTaskDraftStore } from './task-draft.js';

const form = (): TaskBody => ({
  title: 'Car insurance renews',
  notes: '',
  tags: [],
  priority: 1,
  reminderSlot: 'morning',
  scheduleKind: 'fixed',
  allDay: true,
  dueDate: '2026-11-01',
  rrule: 'FREQ=YEARLY',
  workingDaysOnly: false,
  remindOffsetDays: 0,
  reminderProfile: 'standard',
  assignmentMode: 'fixed',
  assigneeIds: [],
  milestones: [],
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

  it('drops corrupt JSON', () => {
    sessionStorage.setItem(TASK_DRAFT_KEY, 'not json{');
    expect(useTaskDraftStore().take()).toBeNull();
    expect(sessionStorage.getItem(TASK_DRAFT_KEY)).toBeNull();
  });

  it('drops a draft with an invalid enum value', () => {
    sessionStorage.setItem(
      TASK_DRAFT_KEY,
      JSON.stringify({ ...form(), scheduleKind: 'fortnightly' }),
    );
    expect(useTaskDraftStore().take()).toBeNull();
  });

  it('drops a draft with a missing field', () => {
    const missing: Partial<TaskBody> = form();
    delete missing.title;
    sessionStorage.setItem(TASK_DRAFT_KEY, JSON.stringify(missing));
    expect(useTaskDraftStore().take()).toBeNull();
  });

  it('keeps a valid body across a fresh pinia', () => {
    sessionStorage.setItem(TASK_DRAFT_KEY, JSON.stringify(form()));
    expect(reload().take()).toEqual(form());
  });
});
