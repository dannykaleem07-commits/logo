// owned by mail
import { describe, expect, it } from 'vitest';
import { composeProblems, SIGN_OFF } from './ComposeDialog';
import { matchedBecause } from './MessageView';
import { pickThread } from '../MailboxTab';
import type { MailboxThread } from '../../../../api/mailApi';

describe('compose', () => {
  it('signs off as the Claims Team and checks the form', () => {
    expect(SIGN_OFF).toBe('Claims Team, Courtesy Cars Group UK Ltd');
    expect(composeProblems('', '', '')).toEqual(['Add at least one recipient.', 'Add a subject.', 'Write the message.']);
    expect(composeProblems('a@x.test, bad', 'S', 'B')).toEqual(['Not an email address: bad']);
    expect(composeProblems('a@x.test', 'S', 'B')).toEqual([]);
  });
});

describe('mailbox', () => {
  it('explains why a message was filed', () => {
    expect(matchedBecause({ match: { decidedBy: 'auto', score: 100, because: ['our reference CCG-2026-00012 is quoted'], decision: 'auto', candidates: [] } })).toBe('Matched because our reference CCG-2026-00012 is quoted');
    expect(matchedBecause({ match: { decidedBy: 'owner', score: 0, because: ['chosen by the owner'], decision: 'linked', candidates: [] } })).toBe('You filed it because chosen by the owner');
    expect(matchedBecause({ match: null })).toBeNull();
  });
  it('selects the newest thread by default', () => {
    const t = (k: string): MailboxThread => ({ threadKey: k, subject: k, lastAt: '', count: 1, messages: [] });
    expect(pickThread([t('a'), t('b')], undefined)?.threadKey).toBe('a');
    expect(pickThread([t('a'), t('b')], 'b')?.threadKey).toBe('b');
    expect(pickThread([], 'b')).toBeUndefined();
  });
});
