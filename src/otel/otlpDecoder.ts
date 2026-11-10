/**
 * Minimal, hand-rolled protobuf reader for OTLP metrics exports.
 *
 * Scoped to exactly the shape Claude Code's own OTel exporter sends
 * (`ExportMetricsServiceRequest`, `application/x-protobuf`): resource metrics ->
 * scope metrics -> sum-typed counters -> data points -> attributes. Field numbers
 * below are checked against the official opentelemetry-proto sources, not guessed.
 *
 * No `@opentelemetry/*` dependency: this repo has no bundler and ships
 * `node_modules` unbundled into the `.vsix` (see `.vscodeignore`), so a protobuf
 * package's CJS/ESM behavior under plain `tsc` would be an unverified risk for
 * two known metric names.
 */

interface RawField {
  field: number;
  wireType: number;
  /** Present for wire type 0 (varint). */
  varint?: number;
  /** Present for wire types 1 (fixed64, 8 bytes), 2 (length-delimited payload), 5 (fixed32, 4 bytes). */
  bytes?: Buffer;
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) {
      throw new Error('varint runs past end of buffer');
    }
    const byte = buf[pos];
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: pos };
    }
    shift += 7;
    if (shift > 63) {
      throw new Error('varint too long');
    }
  }
}

function readSlice(buf: Buffer, offset: number, length: number): { bytes: Buffer; next: number } {
  const next = offset + length;
  if (next > buf.length) {
    throw new Error('field runs past end of buffer');
  }
  return { bytes: buf.subarray(offset, next), next };
}

/**
 * Flatten every top-level field of one protobuf message into a list. Repeated
 * fields (resource_metrics, metrics, data_points, attributes, ...) simply appear
 * more than once — callers filter by field number. A field this module doesn't
 * recognize is left in the list and never read further by any caller, which is
 * how unknown fields are "skipped": protobuf forward-compatibility means a newer
 * exporter can add fields or whole metrics we don't handle without breaking this.
 */
function readFields(buf: Buffer): RawField[] {
  const fields: RawField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    const field = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    offset = tag.next;

    switch (wireType) {
      case 0: {
        const { value, next } = readVarint(buf, offset);
        fields.push({ field, wireType, varint: value });
        offset = next;
        break;
      }
      case 1: {
        const { bytes, next } = readSlice(buf, offset, 8);
        fields.push({ field, wireType, bytes });
        offset = next;
        break;
      }
      case 2: {
        const { value: length, next: start } = readVarint(buf, offset);
        const { bytes, next } = readSlice(buf, start, length);
        fields.push({ field, wireType, bytes });
        offset = next;
        break;
      }
      case 5: {
        const { bytes, next } = readSlice(buf, offset, 4);
        fields.push({ field, wireType, bytes });
        offset = next;
        break;
      }
      default:
        throw new Error(`unsupported protobuf wire type ${wireType} for field ${field}`);
    }
  }
  return fields;
}

/** `AnyValue`: string_value=1 (string), int_value=3 (varint/int64), double_value=4 (fixed64). */
function decodeAnyValue(bytes: Buffer): string | number | undefined {
  for (const f of readFields(bytes)) {
    if (f.field === 1 && f.bytes) {
      return f.bytes.toString('utf8');
    }
    if (f.field === 3 && f.varint !== undefined) {
      return f.varint;
    }
    if (f.field === 4 && f.bytes) {
      return f.bytes.readDoubleLE(0);
    }
  }
  return undefined;
}

/** `KeyValue`: key=1 (string), value=2 (AnyValue). */
function decodeKeyValue(bytes: Buffer): { key: string; value: string | number } | undefined {
  let key: string | undefined;
  let value: string | number | undefined;
  for (const f of readFields(bytes)) {
    if (f.field === 1 && f.bytes) {
      key = f.bytes.toString('utf8');
    } else if (f.field === 2 && f.bytes) {
      value = decodeAnyValue(f.bytes);
    }
  }
  return key !== undefined && value !== undefined ? { key, value } : undefined;
}

interface DecodedDataPoint {
  value: number;
  timestampMs: number;
  attributes: Record<string, string | number>;
}

/**
 * `Sum.aggregation_temporality` (field 2 of the `Sum` message): 1=DELTA, 2=CUMULATIVE,
 * 0=unspecified. Every fixture and real sample seen so far omits this field entirely
 * (Claude Code's exporter doesn't set it, or it's always 2) — 'cumulative' is the
 * default for anything that isn't explicitly 1, matching that observed behavior.
 */
export type AggregationTemporality = 'delta' | 'cumulative';

function decodeAggregationTemporality(varint: number | undefined): AggregationTemporality {
  return varint === 1 ? 'delta' : 'cumulative';
}

/**
 * `NumberDataPoint`: attributes=7 (repeated KeyValue), time_unix_nano=3 (fixed64,
 * uint64 ns), as_double=4 (fixed64, IEEE-754), as_int=6 (fixed64, sfixed64).
 */
function decodeNumberDataPoint(bytes: Buffer): DecodedDataPoint {
  const attributes: Record<string, string | number> = {};
  let timestampMs = 0;
  let value = 0;

  for (const f of readFields(bytes)) {
    if (f.field === 7 && f.bytes) {
      const kv = decodeKeyValue(f.bytes);
      if (kv) {
        attributes[kv.key] = kv.value;
      }
    } else if (f.field === 3 && f.bytes) {
      timestampMs = Number(f.bytes.readBigUInt64LE(0) / 1_000_000n);
    } else if (f.field === 4 && f.bytes) {
      value = f.bytes.readDoubleLE(0);
    } else if (f.field === 6 && f.bytes) {
      value = Number(f.bytes.readBigInt64LE(0));
    }
  }

  return { value, timestampMs, attributes };
}

/** `Sum`: data_points=1 (repeated NumberDataPoint), aggregation_temporality=2 (varint). */
function decodeSum(bytes: Buffer): { dataPoints: DecodedDataPoint[]; temporality: AggregationTemporality } {
  const fields = readFields(bytes);
  const dataPoints = fields
    .filter((f): f is RawField & { bytes: Buffer } => f.field === 1 && !!f.bytes)
    .map((f) => decodeNumberDataPoint(f.bytes));
  const temporalityField = fields.find((f) => f.field === 2);
  return { dataPoints, temporality: decodeAggregationTemporality(temporalityField?.varint) };
}

interface DecodedMetric {
  name: string;
  dataPoints: DecodedDataPoint[];
  temporality: AggregationTemporality;
}

/**
 * `Metric`: name=1 (string), sum=7 (Sum). Metrics without a populated `sum` field
 * (gauges, histograms — e.g. `claude_code.lines_of_code.count` is a plain counter
 * but other instrument kinds exist) are dropped here: Claude Code's cost/token
 * counters are always Sum-typed, so anything else is out of scope by construction.
 */
function decodeMetric(bytes: Buffer): DecodedMetric | undefined {
  const fields = readFields(bytes);
  const nameField = fields.find((f) => f.field === 1 && f.bytes);
  const sumField = fields.find((f) => f.field === 7 && f.bytes);
  if (!nameField?.bytes || !sumField?.bytes) {
    return undefined;
  }
  const { dataPoints, temporality } = decodeSum(sumField.bytes);
  return { name: nameField.bytes.toString('utf8'), dataPoints, temporality };
}

/** `ScopeMetrics`: metrics=2 (repeated Metric). */
function decodeScopeMetrics(bytes: Buffer): DecodedMetric[] {
  return readFields(bytes)
    .filter((f): f is RawField & { bytes: Buffer } => f.field === 2 && !!f.bytes)
    .map((f) => decodeMetric(f.bytes))
    .filter((metric): metric is DecodedMetric => metric !== undefined);
}

/** `ResourceMetrics`: scope_metrics=2 (repeated ScopeMetrics). */
function decodeResourceMetrics(bytes: Buffer): DecodedMetric[] {
  return readFields(bytes)
    .filter((f): f is RawField & { bytes: Buffer } => f.field === 2 && !!f.bytes)
    .flatMap((f) => decodeScopeMetrics(f.bytes));
}

export interface DecodedCostDataPoint {
  metricName: string;
  /** `as_double ?? as_int` — for `claude_code.cost.usage` this is USD. */
  valueUsd: number;
  timestampMs: number;
  attributes: Record<string, string | number>;
  /** Whether `valueUsd` is a running total since the meter started, or an increment since the last export. */
  temporality: AggregationTemporality;
}

/**
 * Decode one OTLP `ExportMetricsServiceRequest` (top-level: resource_metrics=1,
 * repeated ResourceMetrics).
 *
 * Throws only on structurally-impossible input (a length or varint that runs past
 * the buffer, or an unsupported wire type) — never on merely-unrecognized fields
 * or metric names, so a newer Claude Code version emitting metrics this decoder
 * doesn't know about cannot break the ones it does.
 */
export function decodeExportMetricsRequest(buffer: Buffer): DecodedCostDataPoint[] {
  const metrics = readFields(buffer)
    .filter((f): f is RawField & { bytes: Buffer } => f.field === 1 && !!f.bytes)
    .flatMap((f) => decodeResourceMetrics(f.bytes));

  const points: DecodedCostDataPoint[] = [];
  for (const metric of metrics) {
    for (const dp of metric.dataPoints) {
      points.push({
        metricName: metric.name,
        valueUsd: dp.value,
        timestampMs: dp.timestampMs,
        attributes: dp.attributes,
        temporality: metric.temporality,
      });
    }
  }
  return points;
}
