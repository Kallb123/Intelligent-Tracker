import { ref, watch, type Ref } from 'vue';
import { DEFAULT_TASK_SORT, isTaskSort, type TaskSort } from '../tasks/sort.js';

export const TASK_SORT_STORAGE_KEY = 'tracker.tasks.sort';

function readStored(): TaskSort {
  try {
    const stored = localStorage.getItem(TASK_SORT_STORAGE_KEY);
    if (isTaskSort(stored)) return stored;
  } catch {
    // Storage blocked or unavailable: use the default.
  }
  return DEFAULT_TASK_SORT;
}

/**
 * How the All tasks page orders its list, remembered per browser. A stored value that is not a
 * known sort is ignored, and storage that is blocked just means the choice is not remembered.
 */
export function useTaskSort(): Ref<TaskSort> {
  const sort = ref<TaskSort>(readStored());
  watch(sort, (value) => {
    try {
      localStorage.setItem(TASK_SORT_STORAGE_KEY, value);
    } catch {
      // Not remembered; the page still works.
    }
  });
  return sort;
}
