/**
 * The merged Claude Dashboard webview: one panel, one shared CSP/nonce, two tabs
 * (Budget / Token Improver) switched instantly client-side with no host round trip.
 * Replaces the old separate `dashboardPanel` (budget) and `AnalyticsPanel` (Token
 * Improver) panels — this class owns the single webview both used to own
 * independently.
 */

import * as vscode from 'vscode';
import { AnalyticsTracker } from '../analytics/tracker';
import { RealCostTracker } from '../analytics/realCostTracker';
import { buildAccountHeaderHtml, buildBudgetSectionHtml, Summary } from './budgetDashboard';
import { UnifiedRateLimitSnapshot } from '../proxy/server';
import { ALL, AnalyticsFilters, buildAnalyticsSectionHtml, TURN_SETTLE_MS } from './analyticsPanel';
import { extractPlanInfo, showsBudgetTab } from './planView';
import { HOVER_TOOLTIP_SCRIPT, htmlDocument, makeNonce } from './shared';

export type DashboardTab = 'budget' | 'improver';

export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private static latestRateLimit: UnifiedRateLimitSnapshot | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly tracker: AnalyticsTracker;
  private readonly realCostTracker: RealCostTracker | undefined;
  private summary: Summary | undefined;
  private rateLimit: UnifiedRateLimitSnapshot | undefined;
  private filters: AnalyticsFilters;
  private activeTab: DashboardTab;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];

  private constructor(tracker: AnalyticsTracker, realCostTracker: RealCostTracker | undefined, initialTab: DashboardTab) {
    this.tracker = tracker;
    this.realCostTracker = realCostTracker;
    // Every project mixed, newest turn first; the Project filter narrows it to one.
    this.filters = { project: ALL, range: 'today' };
    this.activeTab = initialTab;
    this.rateLimit = DashboardPanel.latestRateLimit;

    // 2.1: a split editor pane beside whatever the user is already looking at,
    // inside this same VS Code window — not `workbench.action.moveEditorToNewWindow`.
    this.panel = vscode.window.createWebviewPanel(
      'claudeDashboard',
      'Claude Dashboard',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; project?: string; range?: string; from?: string; to?: string; tab?: string }) => {
        if (message?.type === 'filter') {
          const range = message.range;
          this.filters = {
            project: message.project ?? this.filters.project,
            range: range === 'today' || range === 'yesterday' || range === '7d' || range === 'month' || range === 'lastMonth' || range === 'custom' ? range : this.filters.range,
            from: message.from ?? this.filters.from,
            to: message.to ?? this.filters.to,
          };
          this.render();
        } else if (message?.type === 'ready') {
          // The page is loaded and listening: bring it up to date with anything that changed meanwhile.
          this.ready = true;
          this.render();
        } else if (message?.type === 'tab' && (message.tab === 'budget' || message.tab === 'improver')) {
          // Client-side already swapped the visible pane — just remember the choice
          // so the next host-triggered re-render (a new turn, a budget refresh)
          // reopens on the same tab instead of snapping back to Budget.
          this.activeTab = message.tab;
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** Open the panel, or reveal and refresh the existing one. `initialTab` only applies on first creation. */
  static show(tracker: AnalyticsTracker, realCostTracker?: RealCostTracker, initialTab: DashboardTab = 'budget'): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.render();
      return DashboardPanel.current;
    }

    const panel = new DashboardPanel(tracker, realCostTracker, initialTab);
    DashboardPanel.current = panel;
    panel.render();
    return panel;
  }

  /** Ledger-driven refresh (called after each recorded turn). Re-renders in place if the panel is open. */
  static refreshIfOpen(): void {
    DashboardPanel.current?.render();
    DashboardPanel.current?.scheduleSettle();
  }

  /** Re-render once the turn has been quiet for TURN_SETTLE_MS, so the period table absorbs it. */
  private scheduleSettle(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.render();
    }, TURN_SETTLE_MS + 50);
  }

  /** Budget-side refresh (called after each Python summary fetch). Re-renders in place if the panel is open. */
  static updateSummary(summary: Summary): void {
    if (!DashboardPanel.current) {
      return;
    }
    DashboardPanel.current.summary = summary;
    DashboardPanel.current.render();
  }

  /** Fresh session/weekly rate-limit reading (Pro/Max/Team). Re-renders in place if the panel is open. */
  static updateRateLimit(info: UnifiedRateLimitSnapshot | undefined): void {
    // Remembered even while the panel is closed, so one opened later starts with it.
    DashboardPanel.latestRateLimit = info;
    if (!DashboardPanel.current) {
      return;
    }
    DashboardPanel.current.rateLimit = info;
    DashboardPanel.current.render();
  }

  private loaded = false;
  private ready = false;

  /**
   * The first call loads the page; every later one posts the new body to it and the page patches
   * only what changed. Replacing the whole HTML on each update (a live turn updates it several
   * times a second) closed open dropdowns, cut clicks short and reset scrolling mid-gesture.
   */
  private render(): void {
    if (!this.loaded) {
      this.loaded = true;
      this.panel.webview.html = this.buildHtml();
      return;
    }
    if (this.ready) {
      void this.panel.webview.postMessage({ type: 'update', body: this.buildBody() });
    }
  }

  private buildBody(): string {
    const budgetBody = this.summary ? buildBudgetSectionHtml(this.summary, this.rateLimit) : '<div class="empty">Loading budget data…</div>';
    const improverBody = buildAnalyticsSectionHtml(this.tracker, this.filters,
      this.realCostTracker,
      this.summary ? extractPlanInfo(this.summary as unknown as Record<string, unknown>) : undefined
    );
    // Enterprise has no budget data to show yet, so the tab is hidden and the Token Improver takes over.
    const plan = this.summary ? extractPlanInfo(this.summary as unknown as Record<string, unknown>) : undefined;
    const showBudget = plan?.organizationType !== 'claude_enterprise';
    const budgetActive = showBudget && this.activeTab === 'budget';

    return `
  ${buildAccountHeaderHtml(this.summary, this.rateLimit)}
  <div class="tabs">
    ${showBudget ? `<button class="tab${budgetActive ? ' active' : ''}" data-tab="budget">Budget</button>` : ''}
    <button class="tab${budgetActive ? '' : ' active'}" data-tab="improver">Token Improver</button>
  </div>
  ${showBudget ? `<div class="tab-panel${budgetActive ? ' active' : ''}" data-panel="budget">${budgetBody}</div>` : ''}
  <div class="tab-panel${budgetActive ? '' : ' active'}" data-panel="improver">${improverBody}</div>`;
  }

  private buildHtml(): string {
    const nonce = makeNonce();
    const body = `<div id="root">${this.buildBody()}</div>`;

    const script = `${HOVER_TOOLTIP_SCRIPT}
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const FILTERS = ['project', 'range', 'from', 'to'];
  // Classes the page itself toggles (expanded turns, the running flash): an update never takes them off.
  const CLIENT_CLASSES = ['open-turn', 'open', 'flash'];

  // What the user is doing survives every update: which turns are expanded and where the page and
  // the turns table are scrolled. It also lives in webview state, so a reload restores it.
  const saved = vscode.getState() || {};
  const open = {};
  (saved.open || []).forEach(function (k) { open[k] = true; });
  let prevCells = saved.cells;

  function scroller() { return document.querySelector('.turns-main'); }
  // The totals row sticks right under the column labels, so it needs to know how tall they are.
  function syncHead() {
    document.querySelectorAll('.turns-table').forEach(function (t) {
      const head = t.querySelector('thead tr');
      if (head) t.style.setProperty('--head-h', head.getBoundingClientRect().height + 'px');
    });
  }
  function save(cells) {
    const s = vscode.getState() || {};
    if (cells) s.cells = cells;
    s.open = Object.keys(open);
    s.scrollY = window.scrollY;
    const sc = scroller();
    s.tableTop = sc ? sc.scrollTop : 0;
    vscode.setState(s);
  }
  function applyOpenAll() {
    document.querySelectorAll('tr[data-toggle]').forEach(function (tr) {
      tr.classList.toggle('open-turn', !!open[tr.getAttribute('data-toggle')]);
    });
    document.querySelectorAll('tr.hit-row').forEach(function (tr) {
      tr.classList.toggle('open', !!open[tr.getAttribute('data-parent')]);
    });
  }

  // One set of listeners on the document: the elements underneath are patched, never replaced.
  document.addEventListener('click', function (event) {
    const tab = event.target.closest('.tab');
    if (tab) {
      const target = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-panel') === target); });
      vscode.postMessage({ type: 'tab', tab: target });
      return;
    }
    const tr = event.target.closest('tr[data-toggle]');
    if (tr && tr.children[0].contains(event.target)) {
      const turn = tr.getAttribute('data-toggle');
      if (open[turn]) delete open[turn]; else open[turn] = true;
      applyOpenAll();
      save();
    }
  });
  document.addEventListener('change', function (event) {
    const el = event.target;
    if (el && FILTERS.indexOf(el.id) >= 0) {
      const msg = { type: 'filter' };
      msg[el.id] = el.value;
      vscode.postMessage(msg);
    }
  });
  document.addEventListener('scroll', function () { save(); }, true);
  document.addEventListener('animationend', function (event) {
    if (event.target.classList) event.target.classList.remove('flash');
  });

  // ---- in-place patching: make the live DOM match the new markup without replacing untouched nodes ----
  function sameNode(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
    return a.nodeType !== 1 || a.getAttribute('data-row') === b.getAttribute('data-row');
  }
  function syncAttrs(a, b) {
    Array.prototype.slice.call(a.attributes).forEach(function (attr) {
      if (attr.name !== 'class' && !b.hasAttribute(attr.name)) a.removeAttribute(attr.name);
    });
    Array.prototype.forEach.call(b.attributes, function (attr) {
      if (attr.name === 'class') return;
      if (a.getAttribute(attr.name) !== attr.value) a.setAttribute(attr.name, attr.value);
    });
    // Tabs and panes are switched on the page itself; everything else takes the new classes plus its own client ones.
    if (a.hasAttribute('data-tab') || a.hasAttribute('data-panel')) return;
    const keep = CLIENT_CLASSES.filter(function (c) { return a.classList.contains(c); });
    const cls = (b.getAttribute('class') || '').split(' ').filter(function (c) { return c && CLIENT_CLASSES.indexOf(c) < 0; }).concat(keep).join(' ');
    if ((a.getAttribute('class') || '') !== cls) { if (cls) a.setAttribute('class', cls); else a.removeAttribute('class'); }
  }
  function morph(a, b) {
    if (a.nodeType === 3 || a.nodeType === 8) {
      if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
      return;
    }
    syncAttrs(a, b);
    const tag = a.nodeName;
    const focused = document.activeElement === a;
    if (tag === 'INPUT') {
      if (!focused) a.value = b.getAttribute('value') || '';
      return;
    }
    if (tag === 'SELECT') {
      // Rewriting the options of a dropdown that is open would close it: leave it alone unless they differ.
      if (a.innerHTML === b.innerHTML) return;
      const chosen = a.value;
      morphChildren(a, b);
      if (focused) a.value = chosen; else a.value = b.value;
      return;
    }
    morphChildren(a, b);
  }
  function morphChildren(a, b) {
    const want = Array.prototype.slice.call(b.childNodes);
    for (let i = 0; i < want.length; i++) {
      const next = want[i];
      const cur = a.childNodes[i];
      if (!cur) { a.appendChild(next.cloneNode(true)); continue; }
      if (sameNode(cur, next)) { morph(cur, next); continue; }
      // A keyed row that moved: pull the matching one forward instead of rebuilding it.
      let match = null;
      if (next.nodeType === 1 && next.hasAttribute('data-row')) {
        for (let j = i + 1; j < a.childNodes.length; j++) {
          if (sameNode(a.childNodes[j], next)) { match = a.childNodes[j]; break; }
        }
      }
      if (match) { a.insertBefore(match, cur); morph(match, next); }
      else a.insertBefore(next.cloneNode(true), cur);
    }
    while (a.childNodes.length > want.length) a.removeChild(a.lastChild);
  }

  /** Flash the cells whose text changed since the last paint (Time, repo and status never flash). */
  function flashChanges() {
    const next = {};
    document.querySelectorAll('tr[data-row]').forEach(function (tr) {
      const row = tr.getAttribute('data-row');
      // A hit of a collapsed turn is hidden, so it must not spend its flash while nobody can see it.
      const parent = tr.getAttribute('data-parent');
      const visible = !parent || open[parent];
      // Each changed cell flashes 100 ms after the previous one (capped at 500 ms), so several read as a flow.
      let changed = 0;
      Array.prototype.forEach.call(tr.children, function (td, i) {
        const key = row + '|' + i;
        const text = td.textContent;
        next[key] = text;
        if (visible && i >= 3 && prevCells && key in prevCells && prevCells[key] !== text) {
          td.classList.remove('flash');
          void td.offsetWidth;
          td.style.animationDelay = Math.min(changed * 100, 500) + 'ms';
          td.classList.add('flash');
          changed++;
        }
      });
    });
    prevCells = next;
    save(next);
  }

  /** Apply an update, keeping the row the user is looking at where it is when new turns appear above it. */
  function patch(html) {
    const sc = scroller();
    let anchorKey = null;
    let anchorTop = 0;
    if (sc && sc.scrollTop > 0) {
      const top = sc.getBoundingClientRect().top;
      const rows = sc.querySelectorAll('tr[data-row]');
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (r.bottom > top + 1 && r.height > 0) { anchorKey = rows[i].getAttribute('data-row'); anchorTop = r.top - top; break; }
      }
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    morphChildren(root, tmp);
    applyOpenAll();
    syncHead();
    const sc2 = scroller();
    if (sc2 && anchorKey !== null) {
      const row = Array.prototype.find.call(sc2.querySelectorAll('tr[data-row]'), function (r) { return r.getAttribute('data-row') === anchorKey; });
      if (row) sc2.scrollTop += (row.getBoundingClientRect().top - sc2.getBoundingClientRect().top) - anchorTop;
    }
    flashChanges();
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'update') patch(event.data.body);
  });

  applyOpenAll();
  syncHead();
  window.scrollTo(0, saved.scrollY || 0);
  const first = scroller();
  if (first) first.scrollTop = saved.tableTop || 0;
  flashChanges();
  vscode.postMessage({ type: 'ready' });
})();`;

    return htmlDocument('Claude Dashboard', body, { nonce, script });
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    this.panel.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}
