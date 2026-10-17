import { describe, expect, it } from 'vitest';
import { findAssignee } from './assignee.js';
import { ALEX, MEMBERS, SAM } from './test-util.js';

const read = (text: string, members = MEMBERS) => {
  const found = findAssignee(text, members);
  return found ? { member: found.member, text: text.slice(found.start, found.end) } : null;
};

describe('findAssignee', () => {
  it('reads @Name and for Name, case-insensitively', () => {
    expect(read('@Sam wash up')).toEqual({ member: SAM, text: '@Sam' });
    expect(read('wash up @sam')).toEqual({ member: SAM, text: '@sam' });
    expect(read('wash up for ALEX')).toEqual({ member: ALEX, text: 'for ALEX' });
    expect(read('(@Sam)')).toEqual({ member: SAM, text: '@Sam' });
  });

  it('accepts a full name and stops at the end of it', () => {
    expect(read('Pay bills for Sam Jones on Friday')).toEqual({
      member: SAM,
      text: 'for Sam Jones',
    });
    expect(read('@alex smith do it')).toEqual({ member: ALEX, text: '@alex smith' });
    expect(read('for Sam on Friday')).toEqual({ member: SAM, text: 'for Sam' });
  });

  it('does not treat unknown names as assignees', () => {
    expect(read('Call the vet for mum')).toBeNull();
    expect(read('Buy a gift for the dog')).toBeNull();
    expect(read('Do taxes for samuel')).toBeNull();
    expect(read("Gift for Sam's birthday")).toBeNull();
    expect(read('Email sam@example.com')).toBeNull();
    expect(read('nothing here')).toBeNull();
  });

  it('matches nobody when a first name is ambiguous, but a full name is not', () => {
    const members = [ALEX, SAM, { id: '33333333-3333-4333-8333-333333333333', name: 'Sam Brown' }];
    expect(read('for Sam', members)).toBeNull();
    expect(read('for Sam Brown', members)?.member.name).toBe('Sam Brown');
    expect(read('for Sam Jones', members)).toEqual({ member: SAM, text: 'for Sam Jones' });
    const twins = [ALEX, { ...ALEX, id: '44444444-4444-4444-8444-444444444444' }];
    expect(read('for Alex Smith', twins)).toBeNull();
  });

  it('takes the first marker that names someone', () => {
    expect(read('for mum, @Sam')).toEqual({ member: SAM, text: '@Sam' });
    expect(read('@Sam and @Alex')?.member).toEqual(SAM);
  });

  it('copes with no members', () => {
    expect(read('@Sam', [])).toBeNull();
  });
});
