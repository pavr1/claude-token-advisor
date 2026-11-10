import assert from 'node:assert/strict';
import test from 'node:test';

import { findBypassing, parseScanOutput, PY_SCAN } from '../proxy/processScan';

const PROXY = 'http://127.0.0.1:4000';

test('scan output is parsed, with an empty value meaning the variable is not set', () => {
  const parsed = parseScanOutput('15292|\r\n23040|http://127.0.0.1:4000/w/proj\r\nnoise line\r\n');
  assert.deepEqual(parsed, [
    { pid: 15292, baseUrl: undefined },
    { pid: 23040, baseUrl: 'http://127.0.0.1:4000/w/proj' },
  ]);
});

test('a claude without the variable, or pointing elsewhere, is flagged as bypassing the proxy', () => {
  const bad = findBypassing(
    [
      { pid: 1, baseUrl: undefined },
      { pid: 2, baseUrl: 'http://127.0.0.1:4000/w/core-banking' },
      { pid: 3, baseUrl: 'https://api.anthropic.com' },
    ],
    PROXY
  );
  assert.deepEqual(
    bad.map((proc) => proc.pid),
    [1, 3]
  );
});

test('a process whose environment could not be read is never listed, so never accused', () => {
  assert.deepEqual(parseScanOutput(''), []);
});

test('the scan script is Python that reads the PEB and takes the root pids as arguments', () => {
  assert.ok(PY_SCAN.includes('NtQueryInformationProcess'));
  assert.ok(PY_SCAN.includes('sys.argv[1:]'));
  assert.ok(!PY_SCAN.includes('powershell'));
});
