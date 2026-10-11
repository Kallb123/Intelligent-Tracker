import type { OccurrenceDto } from '@tracker/shared';
import { onMounted, ref, watch } from 'vue';
import { describeError, getApi } from '../api/index.js';

export interface OccurrenceListQuery {
  view: 'today' | 'upcoming';
  /** How far ahead `upcoming` looks. */
  days?: number;
  /** Only what is assigned to this member; '' or left out for everyone's. */
  memberId?: string;
  /** True while the query is not final yet (the person filter is unchecked): nothing is fetched. */
  wait?: boolean;
}

/**
 * An occurrence list (Today, Coming up) and the things you can do to its items. Every action
 * reloads the list afterwards, so what is shown is what the api says (a completed or snoozed item
 * leaves; completing an "after it's done" task brings its next one in). Reloads also happen when
 * the failure was a conflict, such as completing something a housemate just completed.
 *
 * `query` is read on every load, so a reactive source (the 30/90-day toggle, the person filter)
 * reloads the list.
 */
export function useOccurrenceList(query: () => OccurrenceListQuery) {
  const occurrences = ref<OccurrenceDto[]>([]);
  const loading = ref(true);
  const loadError = ref('');
  const actionError = ref('');
  /** The occurrence an action is running for: its buttons wait. */
  const busyId = ref<string | null>(null);
  let latest = 0;

  async function load(): Promise<void> {
    const request = ++latest;
    const { view, days, memberId, wait } = query();
    if (wait) return;
    try {
      const { data } = await getApi().GET('/api/occurrences', {
        params: {
          query: {
            view,
            ...(days !== undefined && { days }),
            ...(memberId && { memberId }),
          },
        },
      });
      // A slower, older response must not overwrite a newer one (toggling 30/90 quickly).
      if (request !== latest) return;
      occurrences.value = data?.occurrences ?? [];
      loadError.value = '';
    } catch (err) {
      if (request === latest) loadError.value = describeError(err);
    } finally {
      if (request === latest) loading.value = false;
    }
  }

  async function act(id: string, run: () => Promise<unknown>): Promise<void> {
    busyId.value = id;
    actionError.value = '';
    try {
      await run();
    } catch (err) {
      actionError.value = describeError(err);
    }
    await load();
    busyId.value = null;
  }

  const path = (id: string) => ({ params: { path: { id } } });

  const complete = (o: OccurrenceDto) =>
    act(o.id, () => getApi().POST('/api/occurrences/{id}/complete', path(o.id)));
  const start = (o: OccurrenceDto) =>
    act(o.id, () => getApi().POST('/api/occurrences/{id}/start', path(o.id)));
  const snooze = (o: OccurrenceDto, days: number) =>
    act(o.id, () =>
      getApi().POST('/api/occurrences/{id}/snooze', { ...path(o.id), body: { days } }),
    );

  onMounted(load);
  watch(() => JSON.stringify(query()), load);

  return { occurrences, loading, loadError, actionError, busyId, load, complete, start, snooze };
}
