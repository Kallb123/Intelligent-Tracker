import type { OccurrenceDto } from '@tracker/shared';
import { mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { afterEach, describe, expect, it } from 'vitest';
import OccurrenceItem from './OccurrenceItem.vue';

const QUOTES = '66666666-6666-4666-8666-666666666666';
const DECIDE = '77777777-7777-4777-8777-777777777777';

const occurrence = (milestones: OccurrenceDto['milestones'] = []): OccurrenceDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  taskId: '33333333-3333-4333-8333-333333333333',
  task: {
    title: 'Car insurance',
    category: null,
    priority: 0,
    allDay: true,
    scheduleKind: 'fixed',
  },
  dueDate: '2026-10-30',
  dueAt: null,
  startAt: null,
  assigneeId: null,
  status: 'active',
  completedAt: null,
  completedBy: null,
  snoozedUntil: null,
  milestones,
  overdue: false,
});

const milestones: OccurrenceDto['milestones'] = [
  { id: QUOTES, title: 'Get quotes', offsetDaysBeforeDue: 14, done: true },
  { id: DECIDE, title: 'Decide', offsetDaysBeforeDue: 7, done: false },
];

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
});

function mountItem(o: OccurrenceDto, busy = false) {
  wrapper = mount(OccurrenceItem, {
    props: { occurrence: o, detail: 'Due Fri 30 Oct', busy },
    global: { plugins: [PrimeVue], stubs: { 'router-link': { template: '<a><slot /></a>' } } },
  });
  return wrapper;
}

describe('OccurrenceItem milestones', () => {
  it('lists them as a labelled checklist with ticked ones checked and struck through', () => {
    const w = mountItem(occurrence(milestones));

    expect(w.find('ul[aria-label="Milestones of Car insurance"]').exists()).toBe(true);
    const boxes = w.findAll<HTMLInputElement>('.milestone-checklist input');
    expect(boxes.map((b) => b.element.checked)).toEqual([true, false]);
    expect(w.findAll('.milestone-checklist label').map((l) => l.text())).toEqual([
      'Get quotes',
      'Decide',
    ]);
    expect(w.findAll('.milestone-done').map((l) => l.text())).toEqual(['Get quotes']);
    // Each label is tied to its checkbox, so clicking the text toggles it too.
    const [first] = w.findAll('.milestone-checklist label');
    expect(first?.attributes('for')).toBe(boxes[0]?.attributes('id'));
  });

  it('emits the milestone and the new state when one is ticked or unticked', async () => {
    const w = mountItem(occurrence(milestones));
    const boxes = w.findAll<HTMLInputElement>('.milestone-checklist input');

    await boxes[1]!.setValue(true);
    await boxes[0]!.setValue(false);

    expect(w.emitted('milestone')).toEqual([
      [DECIDE, true],
      [QUOTES, false],
    ]);
  });

  it('disables the checkboxes and buttons while an action is running', () => {
    const w = mountItem(occurrence(milestones), true);

    const boxes = w.findAll<HTMLInputElement>('.milestone-checklist input');
    expect(boxes.map((b) => b.element.disabled)).toEqual([true, true]);
    expect(w.get('button[aria-label="Start Car insurance"]').attributes('disabled')).toBeDefined();
    expect(w.get('button[aria-label="Snooze Car insurance"]').attributes('disabled')).toBeDefined();
  });

  it('enables the checkboxes when idle', () => {
    const w = mountItem(occurrence(milestones));
    const boxes = w.findAll<HTMLInputElement>('.milestone-checklist input');
    expect(boxes.map((b) => b.element.disabled)).toEqual([false, false]);
  });

  it('has no checklist without milestones', () => {
    expect(mountItem(occurrence()).find('.milestone-checklist').exists()).toBe(false);
  });
});
