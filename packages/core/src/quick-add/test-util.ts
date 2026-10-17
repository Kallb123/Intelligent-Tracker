import { UK_TEMPLATES } from '@tracker/shared';
import type { QuickAddContext, QuickAddMember } from './types.js';

/** Saturday 17 October 2026, 12:00 in London (BST, which ends on Sunday 25 October). */
export const NOW = new Date('2026-10-17T11:00:00Z');
export const TZ = 'Europe/London';
export const TODAY = '2026-10-17';

export const ALEX: QuickAddMember = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Alex Smith',
};
export const SAM: QuickAddMember = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Sam Jones',
};
export const MEMBERS: readonly QuickAddMember[] = [ALEX, SAM];

export function context(overrides: Partial<QuickAddContext> = {}): QuickAddContext {
  return { now: NOW, timezone: TZ, members: MEMBERS, templates: UK_TEMPLATES, ...overrides };
}
