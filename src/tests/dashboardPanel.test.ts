/** The merged dashboard webview: lifecycle, messages from the page, and what each refresh posts. */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';

import { AnalyticsTracker, LedgerEntry } from '../analytics/tracker';
import { TURN_SETTLE_MS } from '../ui/analyticsPanel';
import { DashboardPanel } from '../ui/dashboardPanel';
import { fake } from './helpers/fakeVscode';

// One recorded turn, so the Token Improver renders its table (and the filters) and not the empty state.
const turn = {
  timestamp: new Date().toISOString(), project: 'repo-a', requestedModel: 'claude-sonnet-5', servedModel: 'claude-sonnet-5',
  modelSwapped: false, rawTokens: 1_000, optimizedTokens: 900, prunedByNormalization: 100, prunedByCompaction: 0,
  compactionTriggered: false, cacheAnchorPlaced: true, uncachedInputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 800,
  outputTokens: 5, baselineUnitCost: 100, actualUnitCost: 50, savingsPercent: 50, newUserTurn: true, status: 200,
} as unknown as LedgerEntry;
const tracker = { getEntries: () => [turn] } as unknown as AnalyticsTracker;

const budgetSummary = (plan: Record<string, unknown> = { organization_type: 'api', budget_api: 'usage_cost' }) => ({
  month: '2026-10',
  plan,
  model_breakdown: [],
});

const panelFake = () => fake.webviewPanels[fake.webviewPanels.length - 1];
const send = (message: unknown): void => panelFake().webview.handler?.(message);
const updates = (): string[] =>
  panelFake().webview.messages.filter((m) => (m as { type: string }).type === 'update').map((m) => (m as { body: string }).body);

/** Open a panel and let its page report ready, so later renders post updates. */
function openReady(tab?: 'budget' | 'improver'): DashboardPanel {
  const panel = DashboardPanel.show(tracker, undefined, tab);
  send({ type: 'ready' });
  panelFake().webview.messages.length = 0;
  return panel;
}

beforeEach(() => {
  fake.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
  // The panel is a singleton: close whatever a test left open and forget the remembered reading.
  for (const p of fake.webviewPanels) {
    p.dispose();
  }
  DashboardPanel.updateRateLimit(undefined);
});

test('show opens one Claude Dashboard panel with scripts on and a nonce-locked page', () => {
  DashboardPanel.show(tracker);
  assert.equal(fake.webviewPanels.length, 1);
  const p = panelFake();
  assert.equal(p.viewType, 'claudeDashboard');
  assert.equal(p.title, 'Claude Dashboard');
  assert.deepEqual(p.options, [{ viewColumn: -1, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true }]);

  const html = p.webview.html;
  const nonce = /<script nonce="([A-Za-z0-9]{32})">/.exec(html)?.[1];
  assert.ok(nonce, 'the script carries a 32-character nonce');
  assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
  assert.match(html, /<div id="root">/);
  assert.match(html, /acquireVsCodeApi\(\)/);
  assert.match(html, /vscode\.postMessage\(\{ type: 'ready' \}\)/);
});

test('every opened page gets its own nonce', () => {
  DashboardPanel.show(tracker);
  const first = /nonce="([^"]+)"/.exec(panelFake().webview.html)?.[1];
  panelFake().dispose();
  DashboardPanel.show(tracker);
  const second = /nonce="([^"]+)"/.exec(panelFake().webview.html)?.[1];
  assert.notEqual(first, second);
});

test('showing again reveals and refreshes the same panel instead of opening a second', () => {
  const first = DashboardPanel.show(tracker);
  send({ type: 'ready' });
  panelFake().webview.messages.length = 0;
  const second = DashboardPanel.show(tracker, undefined, 'improver');
  assert.equal(second, first);
  assert.equal(fake.webviewPanels.length, 1);
  assert.equal(panelFake().reveals, 1);
  assert.equal(updates().length, 1);
});

test('the budget tab is open first by default, and the initial tab applies only on creation', () => {
  DashboardPanel.show(tracker);
  assert.match(panelFake().webview.html, /<button class="tab active" data-tab="budget">Budget<\/button>/);
  assert.match(panelFake().webview.html, /<div class="tab-panel active" data-panel="budget">/);
  assert.match(panelFake().webview.html, /Loading budget data…/);
});

test('opening on the Token Improver tab activates it and leaves the budget pane inactive', () => {
  DashboardPanel.show(tracker, undefined, 'improver');
  const html = panelFake().webview.html;
  assert.match(html, /<button class="tab" data-tab="budget">/);
  assert.match(html, /<button class="tab active" data-tab="improver">/);
  assert.match(html, /<div class="tab-panel active" data-panel="improver">/);
});

test('nothing is posted until the page says it is ready, and then the next refresh updates it in place', () => {
  DashboardPanel.show(tracker);
  DashboardPanel.updateSummary(budgetSummary());
  assert.deepEqual(panelFake().webview.messages, []);

  send({ type: 'ready' });
  assert.equal(updates().length, 1);
  assert.match(updates()[0], /Account: Unknown \(API\)/);
  // The page is never reloaded after the first paint.
  assert.equal((panelFake().webview.html.match(/<!DOCTYPE html>/g) ?? []).length, 1);
});

test('updateSummary swaps the loading note for the budget section', () => {
  openReady();
  DashboardPanel.updateSummary(budgetSummary());
  assert.match(updates()[0], /Claude Budget Advisor/);
  assert.doesNotMatch(updates()[0], /Loading budget data/);
});

test('updateSummary and updateRateLimit do nothing while no panel is open', () => {
  DashboardPanel.updateSummary(budgetSummary());
  assert.doesNotThrow(() => DashboardPanel.updateRateLimit({ fiveHour: undefined, sevenDay: undefined }));
  assert.equal(fake.webviewPanels.length, 0);
});

test('a rate-limit reading received while closed is there when the panel opens', () => {
  DashboardPanel.updateRateLimit({ fiveHour: { utilization: 0.42 } as never, sevenDay: undefined });
  DashboardPanel.show(tracker);
  send({ type: 'ready' });
  assert.match(updates()[0], /Session \(5h\)[\s\S]*42%/);
});

test('a new rate-limit reading re-renders an open panel, and clearing it removes the limits', () => {
  openReady();
  DashboardPanel.updateRateLimit({ fiveHour: { utilization: 0.7 } as never, sevenDay: { utilization: 0.1 } as never });
  assert.match(updates()[0], /Session \(5h\)[\s\S]*70%[\s\S]*Weekly \(7d\)[\s\S]*10%/);
  DashboardPanel.updateRateLimit(undefined);
  assert.doesNotMatch(updates()[1], /Session \(5h\)/);
});

test('an enterprise account has no budget tab, so the Token Improver takes over', () => {
  openReady('budget');
  DashboardPanel.updateSummary(budgetSummary({ organization_type: 'claude_enterprise', budget_api: 'unavailable' }));
  const body = updates()[0];
  assert.doesNotMatch(body, /data-tab="budget"/);
  assert.doesNotMatch(body, /data-panel="budget"/);
  assert.match(body, /<button class="tab active" data-tab="improver">/);
  assert.match(body, /<div class="tab-panel active" data-panel="improver">/);
});

test('the filter message changes the range and project, and re-renders', () => {
  openReady('improver');
  send({ type: 'filter', range: 'yesterday', project: 'repo-a' });
  assert.equal(updates().length, 1);
  assert.match(updates()[0], /<option value="yesterday" selected>Yesterday<\/option>/);
});

test('every known range is accepted and an unknown one keeps the previous range', () => {
  openReady('improver');
  for (const range of ['today', 'yesterday', '7d', 'month', 'lastMonth', 'custom']) {
    send({ type: 'filter', range });
    assert.match(updates().pop() as string, new RegExp(`<option value="${range}" selected>`));
  }
  send({ type: 'filter', range: 'custom' });
  send({ type: 'filter', range: 'next-century' });
  assert.match(updates().pop() as string, /<option value="custom" selected>/);
  // A filter message without a range at all also keeps it.
  send({ type: 'filter', project: 'x' });
  assert.match(updates().pop() as string, /<option value="custom" selected>/);
});

test('custom dates are remembered across filter messages that do not repeat them', () => {
  openReady('improver');
  send({ type: 'filter', range: 'custom', from: '2026-10-01', to: '2026-10-03' });
  assert.match(updates().pop() as string, /Turns 2026-10-01 → 2026-10-03|2026-10-01 → 2026-10-03/);
  send({ type: 'filter', project: 'repo-b' });
  assert.match(updates().pop() as string, /2026-10-01 → 2026-10-03/);
});

test('the tab message is remembered so the next refresh reopens on the same tab', () => {
  openReady('budget');
  DashboardPanel.updateSummary(budgetSummary());
  assert.match(updates().pop() as string, /<button class="tab active" data-tab="budget">/);
  send({ type: 'tab', tab: 'improver' });
  // The page already swapped the pane itself: no round trip.
  assert.equal(updates().length, 1);
  DashboardPanel.updateSummary(budgetSummary());
  assert.match(updates().pop() as string, /<button class="tab active" data-tab="improver">/);
  send({ type: 'tab', tab: 'budget' });
  DashboardPanel.updateSummary(budgetSummary());
  assert.match(updates().pop() as string, /<button class="tab active" data-tab="budget">/);
});

test('unknown tabs, unknown message types and empty messages are ignored', () => {
  openReady('budget');
  send({ type: 'tab', tab: 'nonsense' });
  send({ type: 'something-else' });
  send({});
  send(undefined);
  send(null);
  assert.deepEqual(panelFake().webview.messages, []);
  DashboardPanel.updateSummary(budgetSummary());
  assert.match(updates()[0], /<button class="tab active" data-tab="budget">/);
});

test('a ledger refresh re-renders at once and again after the turn settles', () => {
  openReady();
  DashboardPanel.refreshIfOpen();
  assert.equal(updates().length, 1);
  mock.timers.tick(TURN_SETTLE_MS);
  assert.equal(updates().length, 1, 'not before the settle time');
  mock.timers.tick(50);
  assert.equal(updates().length, 2);
  mock.timers.tick(10 * TURN_SETTLE_MS);
  assert.equal(updates().length, 2, 'the settle render happens once');
});

test('refreshes that keep arriving push the settle render back instead of stacking', () => {
  openReady();
  DashboardPanel.refreshIfOpen();
  mock.timers.tick(TURN_SETTLE_MS);
  DashboardPanel.refreshIfOpen();
  mock.timers.tick(TURN_SETTLE_MS);
  assert.equal(updates().length, 2, 'only the two immediate renders so far');
  mock.timers.tick(50);
  assert.equal(updates().length, 3);
});

test('refreshIfOpen does nothing when no panel is open', () => {
  assert.doesNotThrow(() => DashboardPanel.refreshIfOpen());
  assert.equal(fake.webviewPanels.length, 0);
});

test('closing the panel forgets it, cancels a pending settle render, and lets the next show open a new one', () => {
  const first = openReady();
  DashboardPanel.refreshIfOpen();
  panelFake().dispose();
  assert.equal(panelFake().disposed, true);
  const before = panelFake().webview.messages.length;
  mock.timers.tick(10 * TURN_SETTLE_MS);
  assert.equal(panelFake().webview.messages.length, before);
  assert.doesNotThrow(() => DashboardPanel.refreshIfOpen());

  const next = DashboardPanel.show(tracker);
  assert.notEqual(next, first);
  assert.equal(fake.webviewPanels.length, 2);
});

test('dispose can be called directly and is safe without a pending timer', () => {
  const panel = DashboardPanel.show(tracker);
  panel.dispose();
  assert.equal(panelFake().disposed, true);
  assert.doesNotThrow(() => panel.dispose());
});

test('the page script wires the hooks the host relies on', () => {
  DashboardPanel.show(tracker);
  const html = panelFake().webview.html;
  for (const hook of ["type: 'tab'", "type: 'filter'", "event.data.type === 'update'", 'morphChildren', 'data-row', 'flashChanges']) {
    assert.ok(html.includes(hook), `page script should contain ${hook}`);
  }
  // Both filters the host understands are listened for.
  assert.match(html, /\['project', 'terminal', 'status', 'range', 'from', 'to'\]/);
});

test('the Tips button sits at the end of the tab bar, and the page script opens and closes the popup', () => {
  DashboardPanel.show(tracker, undefined, 'improver');
  const html = panelFake().webview.html;
  // The button is in the tab bar, after the tabs themselves.
  const bar = html.slice(html.indexOf('<div class="tabs">'), html.indexOf('</div>', html.indexOf('<div class="tabs">')));
  assert.ok(bar.indexOf('data-tab="improver"') < bar.indexOf('data-open-tips'), 'after the tabs');
  assert.match(bar, /<button type="button" class="tips-btn" data-open-tips[^>]*><svg[\s\S]*<\/svg>Tips<\/button>/);
  // The popup is in the Token Improver pane, hidden until the script adds `tips-open`.
  assert.match(html, /<div class="tips-modal" data-tips-modal>/);
  assert.match(html, /Tips to save tokens/);
  // An update of the page keeps the popup open: its class belongs to the page, not to the markup.
  assert.match(html, /CLIENT_CLASSES = \['open-turn', 'open', 'flash', 'tips-open'\]/);
  assert.match(html, /event\.target\.closest\('\[data-open-tips\]'\)/);
  assert.match(html, /event\.target\.closest\('\[data-close-tips\]'\) \|\| event\.target\.matches\('\[data-tips-modal\]'\)/);
  assert.match(html, /event\.key === 'Escape'/);
});

test('the /clear banner sits above the tabs on every tab, explains the steps, and goes away when the summary is delivered', () => {
  DashboardPanel.setClearPending(true);
  try {
    DashboardPanel.show(tracker, undefined, 'budget');
    const html = String(panelFake().webview.html);
    assert.match(html, /data-clear-banner/);
    assert.ok(html.indexOf('data-clear-banner') < html.indexOf('<div class="tabs">'), 'above the tabs, so it shows on both');
    assert.match(html, /Run <code>\/clear<\/code> in Claude Code/);
    assert.match(html, /Send your next message/);
    assert.match(html, /starts with the saved summary, so Claude keeps the thread and nothing is lost/);
    assert.match(html, /open since an earlier day\./);
    assert.doesNotMatch(html, /Its history is summarized and ready|cache of an old chat/);
    assert.match(html, /uses more tokens/);

    send({ type: 'ready' });
    panelFake().webview.messages.length = 0;
    DashboardPanel.setClearPending(false);
    assert.equal(updates().length, 1, 'the open page is updated in place');
    assert.doesNotMatch(updates()[0], /data-clear-banner/);
  } finally {
    DashboardPanel.setClearPending(false);
  }
});

test('the /clear banner is remembered while the panel is closed, and an unchanged state does not re-render', () => {
  DashboardPanel.setClearPending(true);
  try {
    DashboardPanel.show(tracker, undefined, 'improver');
    assert.match(String(panelFake().webview.html), /data-clear-banner/, 'a panel opened later starts with it');
    send({ type: 'ready' });
    panelFake().webview.messages.length = 0;
    DashboardPanel.setClearPending(true);
    assert.equal(updates().length, 0, 'same state: nothing to repaint');
  } finally {
    DashboardPanel.setClearPending(false);
  }
});

test('the green "summary delivered" banner shows after delivery, and goes away when turned off', () => {
  DashboardPanel.setClearDone(true);
  try {
    DashboardPanel.show(tracker, undefined, 'budget');
    const html = String(panelFake().webview.html);
    assert.match(html, /clear-banner done[^>]*data-clear-banner-done/);
    assert.match(html, /Summary delivered/);
    assert.ok(html.indexOf('data-clear-banner-done') < html.indexOf('<div class="tabs">'));
    send({ type: 'ready' });
    panelFake().webview.messages.length = 0;
    DashboardPanel.setClearDone(false);
    assert.equal(updates().length, 1);
    assert.doesNotMatch(updates()[0], /data-clear-banner-done/);
  } finally {
    DashboardPanel.setClearDone(false);
  }
});

test('with nothing waiting the page has no /clear banner', () => {
  DashboardPanel.setClearPending(false);
  DashboardPanel.show(tracker);
  assert.doesNotMatch(String(panelFake().webview.html), /data-clear-banner/);
});

test('the /clear banner names the day the chat has been open since, and follows a change of it', () => {
  DashboardPanel.setClearPending(true, new Date(2026, 9, 30, 12).getTime());
  try {
    DashboardPanel.show(tracker, undefined, 'improver');
    assert.match(String(panelFake().webview.html), /open since Fri, Oct 30\./);
    send({ type: 'ready' });
    panelFake().webview.messages.length = 0;
    DashboardPanel.setClearPending(true, new Date(2026, 9, 31, 12).getTime());
    assert.equal(updates().length, 1, 'a new date repaints the open page');
    assert.match(updates()[0], /open since Sat, Oct 31\./);
  } finally {
    DashboardPanel.setClearPending(false);
  }
});
