/** The "run /clear" notice: one popup per wait, and the text every surface carries. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { clearDoneBannerHtml, clearDoneTooltipMarkdown, CLEAR_DONE_MS } from '../ui/clearNotice';
import { chatFirstSeen, CLEAR_NOTICE_ACTION, ClearNotifier, clearBannerHtml, clearNoticeMessage, clearTooltipMarkdown, formatChatSince } from '../ui/clearNotice';

/** A notifier whose popup answers with `choice`, recording every popup and every dashboard opening. */
function notifier(choice: string | undefined = undefined): { notifier: ClearNotifier; shown: Array<[string, string]>; opened: () => number } {
  const shown: Array<[string, string]> = [];
  let opened = 0;
  const n = new ClearNotifier(
    async (message, action) => {
      shown.push([message, action]);
      return choice;
    },
    () => {
      opened += 1;
    }
  );
  return { notifier: n, shown, opened: () => opened };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Friday 30 October 2026, local noon. */
const OCT_30 = new Date(2026, 9, 30, 12).getTime();
const NOW = new Date(2026, 10, 2, 15).getTime();

test('the popup appears once when the summary starts waiting, with the steps and a button to the dashboard', () => {
  const { notifier: n, shown } = notifier();
  n.update(false);
  assert.equal(shown.length, 0, 'nothing waiting: nothing to say');
  n.update(true);
  assert.deepEqual(shown, [[clearNoticeMessage(), CLEAR_NOTICE_ACTION]]);
  const text = clearNoticeMessage();
  // What happened, why it matters, what to do, and what the new chat gets.
  assert.match(text, /this chat has been open since an earlier day/);
  assert.match(text, /resends all of its history with every message, which uses more tokens/);
  assert.match(text, /We summarized that history and saved it/);
  assert.match(text, /Run \/clear and send your next message/);
  assert.match(text, /the new chat starts with that summary, so nothing is lost/);
  assert.doesNotMatch(text, /whole context|all the context/, 'what the new chat gets is the summary, not the context');
});

test('the popup says since when the chat has been open, when the turn that made the summary knows it', () => {
  const { notifier: n, shown } = notifier();
  n.update(true, OCT_30);
  assert.match(shown[0][0], /^New day: this chat has been open since Fri, Oct 30, and Claude Code resends/);
  assert.equal(shown[0][0], clearNoticeMessage(OCT_30));
});

test('it does not repeat on every turn while the summary keeps waiting, and returns for the next wait', () => {
  const { notifier: n, shown } = notifier();
  n.update(true);
  n.update(true);
  n.update(true, OCT_30);
  assert.equal(shown.length, 1, 'turns in the old chat do not pile popups up');
  n.update(false);
  assert.equal(shown.length, 1, 'delivering the summary says nothing');
  n.update(true);
  assert.equal(shown.length, 2, 'a later day leaves a new summary: a new popup');
});

test('pressing the button opens the dashboard; dismissing the popup does not', async () => {
  const pressed = notifier(CLEAR_NOTICE_ACTION);
  pressed.notifier.update(true);
  await settle();
  assert.equal(pressed.opened(), 1);

  const dismissed = notifier(undefined);
  dismissed.notifier.update(true);
  await settle();
  assert.equal(dismissed.opened(), 0);
  dismissed.notifier.update(true);
  await settle();
  assert.equal(dismissed.shown.length, 1, 'a dismissed popup does not come back while the wait lasts');
});

test('a popup that cannot be shown does not break the turn', async () => {
  const n = new ClearNotifier(
    () => Promise.resolve(undefined),
    () => assert.fail('nothing to open')
  );
  assert.doesNotThrow(() => n.update(true));
  await settle();
});

test('the banner explains what happened and what to do, says since when, and holds static text only', () => {
  const banner = clearBannerHtml(OCT_30);
  assert.match(banner, /role="status"/);
  assert.match(banner, /<strong>New day: this chat has been open since Fri, Oct 30\.<\/strong>/);
  assert.match(banner, /resends a chat's whole history with every message, so carrying on in it uses more tokens/);
  assert.match(banner, /already summarized that history and saved it/);
  assert.match(banner, /<ol>[\s\S]*Run <code>\/clear<\/code> in Claude Code[\s\S]*Send your next message[\s\S]*<\/ol>/);
  assert.match(banner, /starts with the saved summary, so Claude keeps the thread and nothing is lost/);
  assert.match(banner, /goes away once the new chat has received the summary/);
  assert.doesNotMatch(banner, /cache/i, 'no word about the cache');
  assert.doesNotMatch(banner, /Its history is summarized and ready/);
  assert.doesNotMatch(banner, /\$\{|undefined/, 'no placeholder leaks into the page');
  assert.match(clearBannerHtml(), /open since an earlier day\./, 'without a date');
});

test('the tooltip carries the same story, with the warning icon', () => {
  const tip = clearTooltipMarkdown(OCT_30);
  assert.match(tip, /\$\(warning\) \*\*New day:\*\* this chat has been open since Fri, Oct 30, and Claude Code resends all of its history/);
  assert.match(tip, /which uses more tokens/);
  assert.match(tip, /The proxy summarized it and saved it/);
  assert.match(tip, /Run `\/clear` and send your next message/);
  assert.match(tip, /the new chat starts with that summary, so nothing is lost/);
  assert.match(tip, /Click this icon for details/);
  assert.match(clearTooltipMarkdown(), /open since an earlier day,/);
});

test('the date is said in local time, with the year only when it is not this one, and "an earlier day" when unknown', () => {
  assert.equal(formatChatSince(OCT_30, NOW), 'Fri, Oct 30');
  assert.equal(formatChatSince(new Date(2025, 11, 31, 23, 30).getTime(), NOW), 'Wed, Dec 31, 2025');
  assert.equal(formatChatSince(undefined, NOW), 'an earlier day');
  assert.equal(formatChatSince(Number.NaN, NOW), 'an earlier day');
  // Late evening local time stays on its local day, whatever the UTC date is.
  assert.equal(formatChatSince(new Date(2026, 9, 30, 23, 30).getTime(), NOW), 'Fri, Oct 30');
});

test('the chat started when the ledger first saw its session, and not knowing the session means not knowing the date', () => {
  const at = (day: number, sessionId?: string) => ({ sessionId, timestamp: new Date(2026, 9, day, 10).toISOString() });
  const entries = [at(31, 'a'), at(29, 'b'), at(30, 'a'), at(28, 'a'), at(27, 'other'), at(26, undefined)];
  assert.equal(chatFirstSeen(entries, 'a'), new Date(2026, 9, 28, 10).getTime(), 'the oldest of its own entries');
  assert.equal(chatFirstSeen(entries, 'b'), new Date(2026, 9, 29, 10).getTime());
  assert.equal(chatFirstSeen(entries, 'missing'), undefined);
  assert.equal(chatFirstSeen(entries, undefined), undefined);
  assert.equal(chatFirstSeen([{ sessionId: 'a', timestamp: 'not a date' }], 'a'), undefined, 'an unreadable time is not a date');
});

test('the delivered confirmation lasts 10 seconds and says the new chat has the summary', () => {
  assert.equal(CLEAR_DONE_MS, 10_000);
  assert.match(clearDoneTooltipMarkdown(), /Summary delivered/);
  assert.match(clearDoneBannerHtml(), /class="clear-banner done"/);
  assert.match(clearDoneBannerHtml(), /new chat received the saved summary/);
});
