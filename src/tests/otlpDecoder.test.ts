/**
 * Unit tests for the hand-rolled OTLP protobuf decoder. Fixtures are built with
 * small local encoders (mirroring how `proxy.test.ts` writes its own
 * `startFakeUpstream` helper) rather than a real protobuf library, so these tests
 * exercise the exact same wire format Claude Code's exporter produces without
 * depending on anything the decoder itself is supposed to replace.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeExportMetricsRequest } from '../otel/otlpDecoder';

// --- Minimal protobuf encoders, just enough to build ExportMetricsServiceRequest fixtures ---

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}

function encodeTag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType);
}

function encodeLengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeTag(field, 2), encodeVarint(payload.length), payload]);
}

function encodeString(field: number, value: string): Buffer {
  return encodeLengthDelimited(field, Buffer.from(value, 'utf8'));
}

function encodeFixed64Double(field: number, value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([encodeTag(field, 1), buf]);
}

function encodeFixed64Uint(field: number, value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return Buffer.concat([encodeTag(field, 1), buf]);
}

/** KeyValue: key=1 (string), value=2 (AnyValue.string_value=1). */
function encodeKeyValueMessage(key: string, value: string): Buffer {
  return Buffer.concat([encodeString(1, key), encodeLengthDelimited(2, encodeString(1, value))]);
}

/** NumberDataPoint: attributes=7 (repeated KeyValue), time_unix_nano=3, as_double=4. */
function encodeNumberDataPointMessage(attributes: Record<string, string>, timeUnixNano: bigint, asDouble: number): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    parts.push(encodeLengthDelimited(7, encodeKeyValueMessage(key, value)));
  }
  parts.push(encodeFixed64Uint(3, timeUnixNano));
  parts.push(encodeFixed64Double(4, asDouble));
  return Buffer.concat(parts);
}

function encodeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([encodeTag(field, 0), encodeVarint(value)]);
}

/** Sum: data_points=1 (repeated NumberDataPoint), aggregation_temporality=2 (varint). `temporality` omitted mimics real-world exports, which never set this field. */
function encodeSumMessage(dataPoints: Buffer[], temporality?: 1 | 2): Buffer {
  const parts = dataPoints.map((dp) => encodeLengthDelimited(1, dp));
  if (temporality !== undefined) {
    parts.push(encodeVarintField(2, temporality));
  }
  return Buffer.concat(parts);
}

/** Metric: name=1 (string), sum=7 (Sum). `sumBytes` undefined mimics a non-Sum metric (gauge/histogram). */
function encodeMetricMessage(name: string, sumBytes: Buffer | undefined): Buffer {
  const parts = [encodeString(1, name)];
  if (sumBytes) {
    parts.push(encodeLengthDelimited(7, sumBytes));
  }
  return Buffer.concat(parts);
}

/** ScopeMetrics: metrics=2 (repeated Metric). */
function encodeScopeMetricsMessage(metrics: Buffer[]): Buffer {
  return Buffer.concat(metrics.map((m) => encodeLengthDelimited(2, m)));
}

/** ResourceMetrics: scope_metrics=2 (repeated ScopeMetrics). */
function encodeResourceMetricsMessage(scopeMetrics: Buffer[]): Buffer {
  return Buffer.concat(scopeMetrics.map((sm) => encodeLengthDelimited(2, sm)));
}

/** ExportMetricsServiceRequest: resource_metrics=1 (repeated ResourceMetrics). */
function encodeExportRequest(resourceMetrics: Buffer[]): Buffer {
  return Buffer.concat(resourceMetrics.map((rm) => encodeLengthDelimited(1, rm)));
}

// --- Tests ---

test('decodes a cost.usage data point with its attributes and timestamp', () => {
  const dataPoint = encodeNumberDataPointMessage(
    { 'user.account_uuid': 'abc-123', 'session.id': 'sess-1' },
    1735689600000000000n,
    0.51
  );
  const metric = encodeMetricMessage('claude_code.cost.usage', encodeSumMessage([dataPoint]));
  const request = encodeExportRequest([encodeResourceMetricsMessage([encodeScopeMetricsMessage([metric])])]);

  const points = decodeExportMetricsRequest(request);

  assert.equal(points.length, 1);
  assert.equal(points[0].metricName, 'claude_code.cost.usage');
  assert.ok(Math.abs(points[0].valueUsd - 0.51) < 1e-9);
  assert.equal(points[0].timestampMs, 1735689600000);
  assert.deepEqual(points[0].attributes, { 'user.account_uuid': 'abc-123', 'session.id': 'sess-1' });
  // No fixture here sets aggregation_temporality — matches every real export seen so far.
  assert.equal(points[0].temporality, 'cumulative');
});

test('an explicit CUMULATIVE aggregation_temporality (2) decodes as cumulative', () => {
  const dataPoint = encodeNumberDataPointMessage({}, 1n, 0.1);
  const metric = encodeMetricMessage('claude_code.cost.usage', encodeSumMessage([dataPoint], 2));
  const request = encodeExportRequest([encodeResourceMetricsMessage([encodeScopeMetricsMessage([metric])])]);

  const points = decodeExportMetricsRequest(request);

  assert.equal(points[0].temporality, 'cumulative');
});

test('an explicit DELTA aggregation_temporality (1) decodes as delta', () => {
  const dataPoint = encodeNumberDataPointMessage({}, 1n, 0.1);
  const metric = encodeMetricMessage('claude_code.cost.usage', encodeSumMessage([dataPoint], 1));
  const request = encodeExportRequest([encodeResourceMetricsMessage([encodeScopeMetricsMessage([metric])])]);

  const points = decodeExportMetricsRequest(request);

  assert.equal(points[0].temporality, 'delta');
});

test('a metric with no sum field (gauge/histogram) is dropped, not thrown, and does not affect siblings', () => {
  const goodPoint = encodeNumberDataPointMessage({}, 1n, 1.23);
  const goodMetric = encodeMetricMessage('claude_code.cost.usage', encodeSumMessage([goodPoint]));
  const gaugeLikeMetric = encodeMetricMessage('claude_code.some_gauge', undefined);

  const request = encodeExportRequest([
    encodeResourceMetricsMessage([encodeScopeMetricsMessage([gaugeLikeMetric, goodMetric])]),
  ]);

  const points = decodeExportMetricsRequest(request);

  assert.equal(points.length, 1);
  assert.equal(points[0].metricName, 'claude_code.cost.usage');
});

test('multiple data points across resource/scope metrics all decode', () => {
  const pointA = encodeNumberDataPointMessage({ model: 'claude-sonnet-5' }, 1n, 0.1);
  const pointB = encodeNumberDataPointMessage({ model: 'claude-opus-5' }, 2n, 0.2);
  const metric = encodeMetricMessage('claude_code.cost.usage', encodeSumMessage([pointA, pointB]));
  const request = encodeExportRequest([encodeResourceMetricsMessage([encodeScopeMetricsMessage([metric])])]);

  const points = decodeExportMetricsRequest(request);

  assert.equal(points.length, 2);
  assert.deepEqual(
    points.map((p) => p.attributes['model']),
    ['claude-sonnet-5', 'claude-opus-5']
  );
});

test('a truncated buffer throws rather than reading out of bounds', () => {
  const dataPoint = encodeNumberDataPointMessage({ 'user.account_uuid': 'abc-123' }, 1n, 0.51);
  const metric = encodeMetricMessage('claude_code.cost.usage', encodeSumMessage([dataPoint]));
  const request = encodeExportRequest([encodeResourceMetricsMessage([encodeScopeMetricsMessage([metric])])]);

  const truncated = request.subarray(0, request.length - 3);

  assert.throws(() => decodeExportMetricsRequest(truncated));
});

test('an empty buffer decodes to no data points', () => {
  assert.deepEqual(decodeExportMetricsRequest(Buffer.alloc(0)), []);
});

// --- Rarer wire shapes: typed attribute values, integer samples, unknown fields, malformed varints ---

function wrapDataPoint(dataPoint: Buffer): Buffer {
  const metric = encodeMetricMessage('claude_code.token.usage', encodeSumMessage([dataPoint]));
  return encodeExportRequest([encodeResourceMetricsMessage([encodeScopeMetricsMessage([metric])])]);
}

/** KeyValue whose AnyValue is `inner` (an already-encoded AnyValue field). */
function encodeKeyValueRaw(key: string, anyValueField: Buffer): Buffer {
  return Buffer.concat([encodeString(1, key), encodeLengthDelimited(2, anyValueField)]);
}

test('attribute values decode as string, integer or double according to the AnyValue field', () => {
  const dataPoint = Buffer.concat([
    encodeLengthDelimited(7, encodeKeyValueRaw('s', encodeString(1, 'text'))),
    encodeLengthDelimited(7, encodeKeyValueRaw('i', Buffer.concat([encodeTag(3, 0), encodeVarint(300)]))),
    encodeLengthDelimited(7, encodeKeyValueRaw('d', encodeFixed64Double(4, 2.5))),
    encodeFixed64Double(4, 1),
  ]);
  const [point] = decodeExportMetricsRequest(wrapDataPoint(dataPoint));
  assert.deepEqual(point.attributes, { s: 'text', i: 300, d: 2.5 });
});

test('attributes with no key, no value or an unsupported AnyValue kind are skipped, not fatal', () => {
  const dataPoint = Buffer.concat([
    encodeLengthDelimited(7, encodeLengthDelimited(2, encodeString(1, 'orphan value'))),
    encodeLengthDelimited(7, encodeString(1, 'orphan key')),
    encodeLengthDelimited(7, encodeKeyValueRaw('bool', Buffer.concat([encodeTag(2, 0), encodeVarint(1)]))),
    encodeLengthDelimited(7, encodeKeyValueRaw('kept', encodeString(1, 'yes'))),
    encodeFixed64Double(4, 1),
  ]);
  const [point] = decodeExportMetricsRequest(wrapDataPoint(dataPoint));
  assert.deepEqual(point.attributes, { kept: 'yes' });
});

test('an as_int sample (sfixed64) decodes, including a negative one', () => {
  const asInt = (value: bigint): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(value, 0);
    return Buffer.concat([encodeTag(6, 1), buf]);
  };
  assert.equal(decodeExportMetricsRequest(wrapDataPoint(asInt(1234n)))[0].valueUsd, 1234);
  assert.equal(decodeExportMetricsRequest(wrapDataPoint(asInt(-5n)))[0].valueUsd, -5);
  // A data point carrying no value at all counts as zero.
  assert.equal(decodeExportMetricsRequest(wrapDataPoint(encodeFixed64Uint(3, 1_000_000n)))[0].valueUsd, 0);
});

test('fixed32 fields and unknown top-level fields are skipped without disturbing known ones', () => {
  const fixed32 = Buffer.concat([encodeTag(9, 5), Buffer.from([1, 2, 3, 4])]);
  const unknownVarint = Buffer.concat([encodeTag(11, 0), encodeVarint(77)]);
  const dataPoint = Buffer.concat([fixed32, unknownVarint, encodeFixed64Double(4, 0.25)]);
  const [point] = decodeExportMetricsRequest(wrapDataPoint(dataPoint));
  assert.equal(point.valueUsd, 0.25);
});

test('malformed input throws a descriptive error', () => {
  // Wire type 3 (start group) is not supported.
  assert.throws(() => decodeExportMetricsRequest(Buffer.concat([encodeTag(1, 3)])), /unsupported protobuf wire type 3 for field 1/);
  // A varint whose continuation bit is set on the last byte runs off the end.
  assert.throws(() => decodeExportMetricsRequest(Buffer.from([0x08, 0x80])), /varint runs past end of buffer/);
  // Eleven continuation bytes exceed 64 bits.
  assert.throws(() => decodeExportMetricsRequest(Buffer.from([0x08, ...new Array(11).fill(0x80), 0x01])), /varint too long/);
  // Fixed32 and fixed64 payloads shorter than declared.
  assert.throws(() => decodeExportMetricsRequest(Buffer.from([(1 << 3) | 5, 1, 2])), /field runs past end of buffer/);
  assert.throws(() => decodeExportMetricsRequest(Buffer.from([(1 << 3) | 1, 1, 2, 3])), /field runs past end of buffer/);
});
