import { taskBodySchema, type TaskBody } from '@tracker/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';

/** The one `sessionStorage` key holding the waiting draft, as JSON. */
export const TASK_DRAFT_KEY = 'tracker.task-draft';

/**
 * The stored draft, if it still passes `taskBodySchema`. It may have been written by an older
 * build (it is meant to outlive an app update), so anything that fails is dropped.
 */
function readStored(): TaskBody | null {
  try {
    const raw = sessionStorage.getItem(TASK_DRAFT_KEY);
    if (raw === null) return null;
    const result = taskBodySchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function writeStored(task: TaskBody | null): void {
  try {
    if (task === null) sessionStorage.removeItem(TASK_DRAFT_KEY);
    else sessionStorage.setItem(TASK_DRAFT_KEY, JSON.stringify(task));
  } catch {
    // Storage is blocked or full: the draft then lives in memory only.
  }
}

/**
 * A task (in the api's shape) handed to the task editor, such as the quick-add's "Edit details".
 * The editor takes it once when it opens a new task. It is also kept in `sessionStorage` until taken, because a new
 * version of the app can replace the page with a full load of the next route (see `pwa.ts`), which
 * would otherwise empty the editor. A stored draft is checked with the shared schema on the way
 * back in. It is per tab and removed by `take`, so a later New task
 * starts blank.
 */
export const useTaskDraftStore = defineStore('task-draft', () => {
  const draft = ref<TaskBody | null>(null);

  function set(task: TaskBody): void {
    draft.value = task;
    writeStored(task);
  }

  /** The waiting draft, if any (in memory, else from before a reload); it is gone afterwards. */
  function take(): TaskBody | null {
    const task = draft.value ?? readStored();
    draft.value = null;
    writeStored(null);
    return task;
  }

  return { draft, set, take };
});
