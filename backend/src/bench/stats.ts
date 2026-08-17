/**
 * Percentiles, and a table renderer for the benchmark output.
 *
 * p95 is reported alongside p50 throughout because the tail is the point. A pipeline
 * whose median is comfortable and whose p95 is two seconds does not feel fast — it feels
 * unreliable, which in a clinical call is worse.
 */

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (rank - lo) * (sorted[hi]! - sorted[lo]!);
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export function summarize(values: number[]): Summary {
  const clean = values.filter((v) => Number.isFinite(v));
  return {
    n: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    min: clean.length ? Math.min(...clean) : NaN,
    max: clean.length ? Math.max(...clean) : NaN,
  };
}

export function ms(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)}` : "—";
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");

  return [
    line(headers),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(line),
  ].join("\n");
}
