import PrimeVue from 'primevue/config';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SelectableText from './SelectableText.vue';

describe('SelectableText', () => {
  it('shows read-only one-line text and selects it on focus', async () => {
    const wrapper = mount(SelectableText, {
      props: { id: 'link', text: 'https://example.test/x', label: 'Link' },
      attachTo: document.body,
      global: { plugins: [PrimeVue] },
    });
    const input = wrapper.get<HTMLInputElement>('input#link');
    expect(input.element.value).toBe('https://example.test/x');
    expect(input.attributes('readonly')).toBeDefined();
    expect(input.attributes('aria-label')).toBe('Link');
    await input.trigger('focus');
    expect(input.element.selectionStart).toBe(0);
    expect(input.element.selectionEnd).toBe('https://example.test/x'.length);
    wrapper.unmount();
  });

  it('uses a read-only textarea for several lines', async () => {
    const text = 'one\ntwo';
    const wrapper = mount(SelectableText, {
      props: { text, label: 'Copy this text', multiline: true },
      attachTo: document.body,
      global: { plugins: [PrimeVue] },
    });
    const area = wrapper.get<HTMLTextAreaElement>('textarea');
    expect(area.element.value).toBe(text);
    expect(area.attributes('readonly')).toBeDefined();
    await area.trigger('focus');
    expect(area.element.selectionEnd).toBe(text.length);
    wrapper.unmount();
  });
});
