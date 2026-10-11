import { computed, ref, watch, type ComputedRef, type WritableComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMembersStore } from '../stores/members.js';

/**
 * The person filter of a list page: a member id, or '' for everyone. It is kept in the URL
 * (`?person=<id>`) so a filtered view survives a reload and can be bookmarked or shared; the
 * address is replaced rather than pushed, so the Back button does not step through filter changes.
 *
 * Only a member of this household counts. The value is '' until the members store has loaded, and
 * stays '' for anything else (an unknown id, a repeated parameter): once the members are known,
 * such a value is dropped from the address, so a bad link shows everyone and never reaches the api.
 * The page must load the members store itself. A list that is filtered by the person should wait
 * for `ready`, so a link to someone's list does not first fetch everyone's.
 */
export function usePersonFilter(): {
  person: WritableComputedRef<string>;
  /** False while a person asked for in the address cannot be checked yet. */
  ready: ComputedRef<boolean>;
} {
  const route = useRoute();
  const router = useRouter();
  const membersStore = useMembersStore();
  const page = route.name;
  const fromQuery = () => {
    const value = route.query['person'];
    return typeof value === 'string' ? value : '';
  };

  const requested = ref(fromQuery());
  const person = computed({
    get: () =>
      membersStore.loaded && membersStore.byId.has(requested.value) ? requested.value : '',
    set: (value: string) => {
      requested.value = value;
    },
  });

  // Keep the address in step with the filter (and tidy a bad one), but only while this page is
  // the current route: leaving it changes the query too.
  watch(
    [person, () => membersStore.loaded],
    () => {
      if (route.name !== page || !membersStore.loaded) return;
      if (route.query['person'] === (person.value || undefined)) return;
      void router.replace({ query: { ...route.query, person: person.value || undefined } });
    },
    { immediate: true },
  );
  // Following a link to the plain page (or Back) shows everyone again.
  watch(
    () => route.query['person'],
    () => {
      if (route.name === page) requested.value = fromQuery();
    },
  );

  // Without a person in the address there is nothing to check; if the members cannot be loaded,
  // stop waiting and show everyone.
  const ready = computed(
    () => requested.value === '' || membersStore.loaded || membersStore.error !== '',
  );

  return { person, ready };
}
