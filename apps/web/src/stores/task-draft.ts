import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { TaskForm } from '../tasks/task-form.js';

/** The one `sessionStorage` key holding the waiting draft, as JSON. */
export const TASK_DRAFT_KEY = 'tracker.task-draft';

/** Enough of a `TaskForm` to trust what was read back from storage; anything else is dropped. */
function isTaskForm(value: unknown): value is TaskForm {
  if (typeof value !== 'object' || value === null) return false;
  const form = value as Record<string, unknown>;
  return (
    typeof form['title'] === 'string' &&
    typeof form['dueDate'] === 'string' &&
    typeof form['recurrence'] === 'object' &&
    form['recurrence'] !== null &&
    Array.isArray(form['milestones']) &&
    Array.isArray(form['rotation'])
  );
}

function readStored(): TaskForm | null {
  try {
    const raw = sessionStorage.getItem(TASK_DRAFT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isTaskForm(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(form: TaskForm | null): void {
  try {
    if (form === null) sessionStorage.removeItem(TASK_DRAFT_KEY);
    else sessionStorage.setItem(TASK_DRAFT_KEY, JSON.stringify(form));
  } catch {
    // Storage is blocked or full: the draft then lives in memory only.
  }
}

/**
 * A task form handed to the task editor, such as the quick-add's "Edit details". The editor takes
 * it once when it opens a new task. It is also kept in `sessionStorage` until taken, because a new
 * version of the app can replace the page with a full load of the next route (see `pwa.ts`), which
 * would otherwise empty the editor. It is per tab and removed by `take`, so a later New task
 * starts blank.
 */
export const useTaskDraftStore = defineStore('task-draft', () => {
  const draft = ref<TaskForm | null>(null);

  function set(form: TaskForm): void {
    draft.value = form;
    writeStored(form);
  }

  /** The waiting draft, if any (in memory, else from before a reload); it is gone afterwards. */
  function take(): TaskForm | null {
    const form = draft.value ?? readStored();
    draft.value = null;
    writeStored(null);
    return form;
  }

  return { draft, set, take };
});
