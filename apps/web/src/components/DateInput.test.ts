import { mount, type VueWrapper } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { afterEach, describe, expect, it } from 'vitest';
import DateInput from './DateInput.vue';

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());

const mountInput = (modelValue: string, props: Record<string, unknown> = {}) => {
  wrapper = mount(DateInput, {
    attachTo: document.body,
    global: { plugins: [PrimeVue] },
    props: {
      id: 'when',
      clearLabel: 'Clear when',
      modelValue,
      'onUpdate:modelValue': (v: string) => wrapper?.setProps({ modelValue: v }),
      ...props,
    },
  });
  return wrapper;
};

describe('DateInput', () => {
  it('shows the date and passes attributes to the input', () => {
    const w = mountInput('2026-10-11', { min: '2026-10-01', invalid: true, ariaDescribedby: 'x' });
    const input = w.get('#when').element as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-10-11');
    expect(input.min).toBe('2026-10-01');
    expect(input.getAttribute('aria-describedby')).toBe('x');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('has a Clear button only while there is a value', async () => {
    const w = mountInput('');
    expect(w.find('button').exists()).toBe(false);
    await w.get('#when').setValue('2026-10-11');
    expect(w.get('button').attributes('aria-label')).toBe('Clear when');
  });

  it('clears the value and returns focus to the input', async () => {
    const w = mountInput('2026-10-11');
    await w.get('button').trigger('click');
    expect((w.vm.$props as { modelValue: string }).modelValue).toBe('');
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['']);
    expect(document.activeElement).toBe(w.get('#when').element);
    expect(w.find('button').exists()).toBe(false);
  });
});
