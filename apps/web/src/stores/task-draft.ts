import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { TaskForm } from '../tasks/task-form.js';

/**
 * A task form handed to the task editor, such as the quick-add's "Edit details". The editor takes
 * it once when it opens a new task; it is never persisted, so a reload starts a blank form.
 */
export const useTaskDraftStore = defineStore('task-draft', () => {
  const draft = ref<TaskForm | null>(null);

  function set(form: TaskForm): void {
    draft.value = form;
  }

  /** The waiting draft, if any; it is gone afterwards. */
  function take(): TaskForm | null {
    const form = draft.value;
    draft.value = null;
    return form;
  }

  return { draft, set, take };
});
