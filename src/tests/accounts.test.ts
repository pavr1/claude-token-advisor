/**
 * Unit tests for the accounts/ registry: which view (percent vs dollar) each
 * org type resolves to. Mirrors tests/test_accounts.py on the Python side.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAccountViewMode } from '../accounts';

test('resolveAccountViewMode: Pro and Max are explicitly percent, regardless of budgetApi', () => {
  assert.equal(resolveAccountViewMode('claude_pro', 'unavailable'), 'percent');
  assert.equal(resolveAccountViewMode('claude_max', 'unavailable'), 'percent');
});

test('resolveAccountViewMode: Enterprise is explicitly dollar — Session/Weekly needs a proxied request first', () => {
  assert.equal(resolveAccountViewMode('claude_enterprise', 'rate_limit'), 'dollar');
  // Even if budgetApi somehow said 'unavailable' (stale data), the explicit
  // registration wins — Enterprise never falls back to percent mode.
  assert.equal(resolveAccountViewMode('claude_enterprise', 'unavailable'), 'dollar');
});

test('resolveAccountViewMode: Team falls back to the budgetApi heuristic (unchanged)', () => {
  assert.equal(resolveAccountViewMode('claude_team', 'unavailable'), 'percent');
});

test('resolveAccountViewMode: API falls back to the budgetApi heuristic (unchanged)', () => {
  assert.equal(resolveAccountViewMode('api', 'usage_cost'), 'dollar');
});

test('resolveAccountViewMode: unknown org type falls back to the budgetApi heuristic', () => {
  assert.equal(resolveAccountViewMode('some_future_plan', 'unavailable'), 'percent');
  assert.equal(resolveAccountViewMode(null, 'unavailable'), 'percent');
});
