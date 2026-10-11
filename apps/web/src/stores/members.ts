import type { MemberDto } from '@tracker/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { describeError, getApi } from '../api/index.js';

/**
 * The household's members, for showing who a task is assigned to and for picking assignees.
 * Loaded once per page visit that needs it; `load` is safe to call from several pages.
 */
export const useMembersStore = defineStore('members', () => {
  const members = ref<MemberDto[]>([]);
  const loaded = ref(false);
  const error = ref('');
  let loading: Promise<void> | undefined;

  const byId = computed(() => new Map(members.value.map((m) => [m.id, m])));

  /** Fetches the list; pass `force` to refetch after it may have changed. */
  function load(force = false): Promise<void> {
    if (force) loading = undefined;
    loading ??= (async () => {
      try {
        const { data } = await getApi().GET('/api/members');
        members.value = data?.members ?? [];
        error.value = '';
        loaded.value = true;
      } catch (err) {
        error.value = describeError(err);
        // Let the next page visit try again.
        loading = undefined;
      }
    })();
    return loading;
  }

  /** Swaps in a member the api returned after a change, instead of refetching the whole list. */
  function replace(member: MemberDto): void {
    members.value = members.value.map((m) => (m.id === member.id ? member : m));
  }

  function nameOf(id: string | null | undefined): string {
    return (id ? byId.value.get(id)?.name : undefined) ?? 'Anyone';
  }

  return { members, loaded, error, byId, load, replace, nameOf };
});
