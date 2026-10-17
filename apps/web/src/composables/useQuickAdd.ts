import {
  describeQuickAdd,
  parseQuickAdd,
  type QuickAddParse,
  type QuickAddRow,
} from '@tracker/core';
import { UK_TEMPLATES, type Template } from '@tracker/shared';
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { describeError, getApi } from '../api/index.js';
import { useMembersStore } from '../stores/members.js';
import { useSessionStore } from '../stores/session.js';
import { useTaskDraftStore } from '../stores/task-draft.js';
import { quickAddBody, quickAddForm } from '../tasks/quick-add.js';

/** What the confirmation card shows: the understanding of `text`, as it was when parsed. */
export interface QuickAddPreview {
  /** The trimmed text the parse offsets refer to. */
  text: string;
  parse: QuickAddParse;
  rows: QuickAddRow[];
}

/**
 * The quick-add bar's state. Submitting parses the text locally (the parser is pure; the
 * household's templates and members are loaded once) and opens a preview. Nothing is saved until
 * `save`; `editDetails` hands the parsed task to the task editor instead. While a preview is
 * open it follows the text, so the card never describes words that are no longer there.
 *
 * `onSaved` runs after the api has created the task.
 */
export function useQuickAdd(onSaved: () => void) {
  const session = useSessionStore();
  const membersStore = useMembersStore();
  const drafts = useTaskDraftStore();
  const router = useRouter();

  const text = ref('');
  const preview = ref<QuickAddPreview | null>(null);
  const error = ref('');
  /** True while the templates are loading for a first preview, and while saving. */
  const busy = ref(false);

  const templates = ref<Template[] | undefined>();
  let loading: Promise<void> | undefined;
  /** The household's templates, once; the built-in ones if they cannot be loaded. */
  function loadTemplates(): Promise<void> {
    loading ??= (async () => {
      try {
        const { data } = await getApi().GET('/api/templates');
        templates.value = data?.templates ?? [...UK_TEMPLATES];
      } catch {
        templates.value = [...UK_TEMPLATES];
      }
    })();
    return loading;
  }

  function parse(): void {
    const value = text.value.trim();
    if (!value) {
      preview.value = null;
      return;
    }
    try {
      const context = {
        now: new Date(),
        timezone: session.timeZone,
        members: membersStore.members,
      };
      const result = parseQuickAdd(value, {
        ...context,
        templates: templates.value ?? UK_TEMPLATES,
      });
      preview.value = { text: value, parse: result, rows: describeQuickAdd(result, context) };
    } catch (err) {
      preview.value = null;
      error.value = describeError(err);
    }
  }

  async function submit(): Promise<void> {
    if (!text.value.trim() || busy.value) return;
    error.value = '';
    busy.value = true;
    try {
      await Promise.all([loadTemplates(), membersStore.load()]);
    } finally {
      busy.value = false;
    }
    // Without the members "@Sam" would quietly be left in the title, so say so instead.
    if (membersStore.error) {
      preview.value = null;
      error.value = `Could not load the household's members, so names cannot be matched. ${membersStore.error}`;
      return;
    }
    parse();
  }

  watch(text, () => {
    error.value = '';
    if (preview.value) parse();
  });

  async function save(): Promise<void> {
    const current = preview.value;
    if (!current || busy.value) return;
    error.value = '';
    busy.value = true;
    try {
      const body = quickAddBody(current.parse, session.member?.id);
      await getApi().POST('/api/tasks', { body });
      preview.value = null;
      text.value = '';
      onSaved();
    } catch (err) {
      error.value = describeError(err);
    } finally {
      busy.value = false;
    }
  }

  /** Opens the task editor on a new task filled in from the preview. */
  async function editDetails(): Promise<void> {
    const current = preview.value;
    if (!current) return;
    error.value = '';
    try {
      drafts.set(quickAddForm(current.parse, session.member?.id, session.timeZone));
      await router.push({ name: 'task-new' });
    } catch {
      // The parsed task is not one the editor can show (a template's default out of range, say).
      error.value = 'That task cannot be opened in the editor. Check the text and try again.';
    }
  }

  /** Closes the preview, keeping the text to adjust. */
  function cancel(): void {
    preview.value = null;
    error.value = '';
  }

  return { text, preview, error, busy, submit, save, editDetails, cancel };
}
