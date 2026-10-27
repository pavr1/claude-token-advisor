/** Presentation helpers shared by both webviews. */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  barRow,
  BASE_STYLES,
  compact,
  donutChart,
  escapeHtml,
  formatPercent,
  formatShare,
  formatUsd,
  helpIcon,
  HOVER_TOOLTIP_SCRIPT,
  htmlDocument,
  makeNonce,
  progressBarText,
} from '../ui/shared';

test('escapeHtml escapes the four characters that can break out of markup or an attribute', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml('plain'), 'plain');
  // The ampersand goes first, so an already-escaped entity is escaped again, not left half-decoded.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('formatPercent and formatShare use two decimals and a dash when there is nothing to divide by', () => {
  assert.equal(formatPercent(12.345), '12.35%');
  assert.equal(formatPercent(-33.333), '-33.33%');
  assert.equal(formatShare(25, 100), '25.00%');
  assert.equal(formatShare(5, 0), '—');
  assert.equal(formatShare(5, -1), '—');
});

test('compact abbreviates thousands, millions and billions, negatives included', () => {
  assert.equal(compact(999), '999');
  assert.equal(compact(1_000), '1.00K');
  assert.equal(compact(1_234_567), '1.23M');
  assert.equal(compact(2_500_000_000), '2.50B');
  assert.equal(compact(-1_500), '-1.50K');
  assert.equal(compact(0), '0');
  assert.equal(compact(12.3456), (12.3456).toLocaleString(undefined, { maximumFractionDigits: 2 }));
});

test('formatUsd keeps precision at small amounts', () => {
  assert.equal(formatUsd(12.345), '$12.35');
  assert.equal(formatUsd(0.5), '$0.500');
  assert.equal(formatUsd(0.0012), '$0.0012');
  assert.equal(formatUsd(-2), '$-2.00');
});

test('progressBarText fills segments in proportion, clamped to 0..100', () => {
  assert.equal(progressBarText(50), '$(circle-filled)'.repeat(5) + '$(circle-outline)'.repeat(5));
  assert.equal(progressBarText(-20), '$(circle-outline)'.repeat(10));
  assert.equal(progressBarText(500), '$(circle-filled)'.repeat(10));
  assert.equal(progressBarText(100, 4), '$(circle-filled)'.repeat(4));
});

test('barRow clamps the fill width and escapes label, value and title', () => {
  const html = barRow('<repo>', '5 & 6', 150, '#fff', 'tip "x"');
  assert.match(html, /width:100\.0%/);
  assert.match(html, /&lt;repo&gt;/);
  assert.match(html, /5 &amp; 6/);
  assert.match(html, /title="tip &quot;x&quot;"/);
  assert.match(barRow('a', 'b', -5, '#fff'), /width:0\.0%/);
  // Without a title the label doubles as one.
  assert.match(barRow('name', 'v', 10, '#fff'), /title="name"/);
});

test('donutChart draws an arc proportional to the percent and clamps it', () => {
  const half = donutChart(50, '#0f0', 'saved');
  const circumference = 2 * Math.PI * 54;
  assert.ok(half.includes(`stroke-dasharray="${(circumference / 2).toFixed(2)} ${(circumference / 2).toFixed(2)}"`));
  assert.match(half, /50\.00%/);
  assert.match(half, /aria-label="saved"/);

  // Over 100 draws a full ring, under 0 an empty one; the label keeps the real number.
  assert.ok(donutChart(250, '#0f0', 'c').includes(`stroke-dasharray="${circumference.toFixed(2)} 0.00"`));
  const negative = donutChart(-33.33, '#f00', 'c', '-33.33%');
  assert.ok(negative.includes(`stroke-dasharray="0.00 ${circumference.toFixed(2)}"`));
  assert.match(negative, /-33\.33%/);
  assert.match(donutChart(10, '#0f0', '<c>', 'x<y'), /&lt;c&gt;[\s\S]*x&lt;y|x&lt;y[\s\S]*&lt;c&gt;/);
});

test('makeNonce returns 32 alphanumeric characters, different each time', () => {
  const a = makeNonce();
  assert.match(a, /^[A-Za-z0-9]{32}$/);
  assert.notEqual(a, makeNonce());
});

test('helpIcon escapes its text into a data-tooltip attribute', () => {
  assert.equal(helpIcon('a "b" <c>'), '<span class="help" tabindex="0" data-tooltip="a &quot;b&quot; &lt;c&gt;">?</span>');
});

test('the hover tooltip script is valid JavaScript and wires the three mouse events', () => {
  assert.doesNotThrow(() => new Function(HOVER_TOOLTIP_SCRIPT));
  for (const event of ['mouseover', 'mousemove', 'mouseout']) {
    assert.ok(HOVER_TOOLTIP_SCRIPT.includes(`'${event}'`), event);
  }
});

test('hover tooltip behaviour: shows the data-tooltip text on hover, repositions near the edges, hides on leaving', () => {
  const handlers: Record<string, (e: unknown) => void> = {};
  const tip = {
    className: '',
    textContent: '',
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
  };
  const target = { getAttribute: () => 'hello' };
  const document = {
    createElement: () => tip,
    body: { appendChild: () => undefined },
    addEventListener: (name: string, fn: (e: unknown) => void) => {
      handlers[name] = fn;
    },
  };
  const window = { innerWidth: 500, innerHeight: 300 };
  new Function('document', 'window', HOVER_TOOLTIP_SCRIPT)(document, window);

  const over = (x: number, y: number, closest: unknown) => ({ clientX: x, clientY: y, target: { closest: () => closest } });

  handlers.mouseover(over(10, 10, null));
  assert.equal(tip.style.display, undefined);

  handlers.mouseover(over(10, 10, target));
  assert.equal(tip.textContent, 'hello');
  assert.equal(tip.style.display, 'block');
  assert.deepEqual([tip.style.left, tip.style.top], ['24px', '24px']);

  // Near the right and bottom edges the tooltip flips to the other side of the cursor.
  handlers.mousemove({ clientX: 480, clientY: 290 });
  assert.deepEqual([tip.style.left, tip.style.top], ['366px', '236px']);

  // Moving onto a child of the same target keeps it open; leaving it hides it.
  handlers.mouseout({ target: { closest: () => target }, relatedTarget: { closest: () => target } });
  assert.equal(tip.style.display, 'block');
  handlers.mouseout({ target: { closest: () => target }, relatedTarget: null });
  assert.equal(tip.style.display, 'none');
  handlers.mouseout({ target: { closest: () => null }, relatedTarget: null });
  handlers.mousemove({ clientX: 1, clientY: 1 });
  assert.equal(tip.style.left, '366px', 'a hidden tooltip does not follow the cursor');
});

test('htmlDocument is script-free by default and allows exactly one nonce-tagged script when asked', () => {
  const plain = htmlDocument('T <1>', '<p>x</p>');
  assert.match(plain, /<title>T &lt;1&gt;<\/title>/);
  assert.match(plain, /default-src 'none'; style-src 'unsafe-inline';"/);
  assert.doesNotMatch(plain, /<script/);
  assert.ok(plain.includes(BASE_STYLES));

  const interactive = htmlDocument('T', '<p>x</p>', { nonce: 'abc', script: 'run();' });
  assert.match(interactive, /script-src 'nonce-abc';/);
  assert.match(interactive, /<script nonce="abc">run\(\);<\/script>/);
});
