/**
 * Every figure the assistant states must be one a tool returned.
 *
 * The system prompt says so, and a model usually complies — but not always.
 * Westport caught it twice in November 2026: a receivables total of $786,338
 * and "32 other won deals … $1,027,400" stated with no tool call behind them,
 * then withdrawn by the assistant itself a turn later. An instruction is not a
 * control. This is the control: before an answer is final, the dollar figures
 * and counts in it are compared with what the tools actually returned in this
 * conversation, and an answer carrying one that matches nothing is sent back
 * to be rewritten.
 *
 * Deliberately narrow. Dollar amounts, and counts of things the reader acts on
 * (deals, accounts, invoices…), because those are what a wrong number costs.
 * Percentages, dates and small counts are left alone: they are usually derived
 * or incidental, and flagging them would send good answers back for nothing.
 */

export interface StatedFigure {
  text: string;
  value: number;
  /** How far the stated value may sit from the source: "$786K" is a rounding. */
  tolerance: number;
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|m|thousand|million)?\b/gi;
const COUNT =
  /\b(\d{1,3}(?:,\d{3})+|\d+)\s+(?:(?:other|more|won|open|new|closed|active|live|matched|unmatched|outstanding|total)\s+){0,2}(deals?|accounts?|invoices?|customers?|contacts?|sqls?|mqls?|proposals?|reviews?|meetings?|companies)\b/gi;

export function statedFigures(answer: string): StatedFigure[] {
  const figures: StatedFigure[] = [];

  for (const match of answer.matchAll(MONEY)) {
    const whole = Number(match[1]!.replace(/,/g, ''));
    const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
    const unit = (match[3] ?? '').toLowerCase();
    const scale = unit === 'k' || unit === 'thousand' ? 1_000 : unit === 'm' || unit === 'million' ? 1_000_000 : 1;
    const value = (whole + fraction) * scale;
    if (value < 100) continue; // "$5" is incidental, not a figure anybody acts on
    figures.push({
      text: match[0].trim(),
      value,
      tolerance: scale > 1 ? value * 0.05 : Math.max(1, value * 0.005),
    });
  }

  for (const match of answer.matchAll(COUNT)) {
    const value = Number(match[1]!.replace(/,/g, ''));
    if (value < 10) continue;
    figures.push({ text: match[0].trim(), value, tolerance: 0 });
  }

  return figures;
}

/** Every number in the evidence — tool results, the user's own messages. */
export function evidenceNumbers(evidence: string[]): number[] {
  const numbers: number[] = [];
  for (const text of evidence) {
    for (const match of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const value = Number(match[0].replace(/,/g, ''));
      if (Number.isFinite(value)) numbers.push(Math.abs(value));
    }
  }
  return numbers;
}

/** The figures in an answer that no evidence supports. */
export function unsupportedFigures(answer: string, evidence: string[]): StatedFigure[] {
  const stated = statedFigures(answer);
  if (stated.length === 0) return [];
  const known = evidenceNumbers(evidence);
  return stated.filter(
    (figure) => !known.some((value) => Math.abs(value - figure.value) <= figure.tolerance),
  );
}
