import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenForInstallPrompt, useInstallPrompt } from './useInstallPrompt.js';

/** A `beforeinstallprompt` event the page can cancel, as the browser's is. */
function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome }),
  });
  window.dispatchEvent(event);
  return event;
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe('useInstallPrompt', () => {
  it('cannot install until the browser offers', () => {
    stop = listenForInstallPrompt();
    const { canInstall } = useInstallPrompt();
    expect(canInstall.value).toBe(false);

    const event = offerInstall();
    expect(canInstall.value).toBe(true);
    // The browser's own banner is suppressed.
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows the browser`s dialog once, then waits for another offer', async () => {
    stop = listenForInstallPrompt();
    const { canInstall, install } = useInstallPrompt();
    const event = offerInstall();

    await install();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(canInstall.value).toBe(false);

    await install();
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('forgets the offer once the app is installed', () => {
    stop = listenForInstallPrompt();
    const { canInstall } = useInstallPrompt();
    offerInstall();
    window.dispatchEvent(new Event('appinstalled'));
    expect(canInstall.value).toBe(false);
  });

  it('stops listening when told to', () => {
    listenForInstallPrompt()();
    const { canInstall } = useInstallPrompt();
    offerInstall();
    expect(canInstall.value).toBe(false);
  });
});
