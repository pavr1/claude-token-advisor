/**
 * The page patches its DOM in place instead of reloading. When the "New day" banner appears or goes away, every sibling after it
 * shifts by one place; the patch must still end up with exactly the new markup. It once left the Token Improver pane with the
 * `tabs` class (a flex row), which laid every section out as a column.
 */

import './helpers/fakeVscode';
import assert from 'node:assert/strict';
import test from 'node:test';

import { clearBannerHtml } from '../ui/clearNotice';
import { PATCH_SCRIPT } from '../ui/dashboardPanel';

// jsdom ships no type declarations; it is a dev dependency used only here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');

const CLIENT_CLASSES = ['open-turn', 'open', 'flash', 'tips-open'];

function page() {
  const document = new JSDOM('<body><div id="root"></div></body>').window.document;
  const root = document.getElementById('root');
  const morphChildren = new Function('document', 'CLIENT_CLASSES', `${PATCH_SCRIPT}; return morphChildren;`)(document, CLIENT_CLASSES);
  const update = (html: string): string => {
    const next = document.createElement('div');
    next.innerHTML = html;
    morphChildren(root, next);
    return next.innerHTML;
  };
  return { document, root, update };
}

const body = (opts: { banner: boolean; budget: boolean; rows?: number }): string =>
  `<div class="page-content"><div class="account">Account</div>${opts.banner ? clearBannerHtml(Date.now() - 864e5) : ''}` +
  `<div class="tabs">${opts.budget ? '<button class="tab" data-tab="budget">Budget</button>' : ''}<button class="tab active" data-tab="improver">Token Improver</button></div>` +
  `${opts.budget ? '<div class="tab-panel" data-panel="budget"><div>budget</div></div>' : ''}` +
  `<div class="tab-panel active" data-panel="improver"><div class="head"><h1>T</h1></div><h2>Turns</h2><table><tbody>` +
  Array.from({ length: opts.rows ?? 2 }, (_, i) => `<tr data-row="p#${i}"><td>row ${i}</td></tr>`).join('') +
  `</tbody></table></div></div>`;

for (const budget of [false, true]) {
  for (const [from, to] of [
    [true, false],
    [false, true],
  ] as const) {
    test(`the banner ${from ? 'going away' : 'showing up'} leaves the page as the new markup says (budget tab: ${budget})`, () => {
      const { root, update } = page();
      update(body({ banner: from, budget }));
      const want = update(body({ banner: to, budget, rows: 3 }));
      assert.equal(root.innerHTML, want);
      const improver = root.querySelector('[data-panel="improver"]');
      assert.equal(improver.getAttribute('class'), 'tab-panel active', 'the pane keeps its own class, not the one of the element that used to be in its place');
      assert.equal(root.querySelectorAll('.tabs').length, 1);
      assert.equal(root.querySelector('.head h2'), null, 'no section ends up inside the header');
    });
  }
}

test('the panes and the tab buttons are not repainted over by a banner that moves them, and client classes survive', () => {
  const { document, root, update } = page();
  update(body({ banner: true, budget: true }));
  root.querySelector('[data-row="p#0"]').classList.add('open-turn');
  const pane = root.querySelector('[data-panel="improver"]');
  update(body({ banner: false, budget: true }));
  assert.equal(root.querySelector('[data-panel="improver"]'), pane, 'the pane node is kept, not rebuilt');
  assert.ok(document.querySelector('[data-row="p#0"]').classList.contains('open-turn'), 'an expanded turn stays expanded');
});

test('a tab the user switched to is not undone by an update that does not change it', () => {
  const { root, update } = page();
  update(body({ banner: false, budget: true }));
  root.querySelector('[data-panel="budget"]').setAttribute('class', 'tab-panel active');
  root.querySelector('[data-panel="improver"]').setAttribute('class', 'tab-panel');
  update(body({ banner: false, budget: true }));
  assert.equal(root.querySelector('[data-panel="budget"]').getAttribute('class'), 'tab-panel active');
  assert.equal(root.querySelector('[data-panel="improver"]').getAttribute('class'), 'tab-panel');
});
