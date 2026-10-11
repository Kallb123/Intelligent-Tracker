import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AppFooter from './AppFooter.vue';

describe('AppFooter', () => {
  it('shows the app version from the root package.json', () => {
    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
    expect(mount(AppFooter).text()).toBe(`v${__APP_VERSION__}`);
  });
});
