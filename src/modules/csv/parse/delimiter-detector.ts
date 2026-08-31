/**
 * Delimiter auto-detection.
 *
 * One incremental detector serves both `Csv.parse` and `CsvParserStream`. That is not tidiness:
 * quote recognition depends on field boundaries, and field boundaries depend on the delimiter
 * being detected, so a batch parse and a streamed parse of the same bytes can only agree if
 * they weigh the candidates by identical rules. While these rules lived in two places — a
 * sampler and a readiness check on the stream — they drifted repeatedly: over what an empty
 * candidate list means, over whether a comment counts towards the sample, over which record
 * separator applies, and over how much text is enough.
 *
 * The detector keeps *no copy of the input*. Each candidate owns a scanner, and every record
 * that scanner completes is counted as it arrives. That is what makes the answer independent of
 * chunking: a candidate is scored on its first `DELIMITER_DETECTION_SAMPLE_RECORDS` complete
 * records, which is a fact about the bytes rather than about where a chunk boundary fell. It is
 * also why deciding is O(candidates) rather than a re-walk of everything buffered, and why a
 * long run of comments cannot grow the detector: those records are consumed like any other.
 */

import type { Scanner, ScannerConfig } from "@csv/parse/scanner";
import { createScanner, scanRow } from "@csv/parse/scanner";

/** Delimiters weighed when none are given. */
const AUTO_DETECT_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * Records each candidate is scored on.
 *
 * A stream must hold this many before committing, or its choice — and therefore its rows —
 * would depend on where the chunk boundaries fell.
 */
const SAMPLE_RECORDS = 10;

/**
 * Characters of *scorable* records a candidate may be scored on, and the amount of undigested
 * text after which a candidate is judged unable to complete another record.
 */
const SAMPLE_CHARS = 65536;

/** Fields a candidate must average before it is considered a delimiter at all. */
const MIN_AVERAGE_FIELDS = 1.99;

/**
 * Candidates a detector will weigh.
 *
 * An empty list is read as "unset", which is what a caller passing one is asking for. It once
 * meant "no candidates, fall back to comma" to a batch parse and "not configured, use the
 * defaults" to a stream, so the same options produced different delimiters.
 */
function delimiterCandidates(delimitersToGuess?: readonly string[]): readonly string[] {
  return delimitersToGuess && delimitersToGuess.length > 0
    ? delimitersToGuess
    : AUTO_DETECT_DELIMITERS;
}

/**
 * Whether a record can contribute to a candidate's score.
 *
 * A record that is empty or only whitespace cannot indicate a delimiter, and a comment is not
 * data. This is deliberately the only copy of the rule: a stream waits for exactly the records
 * the scoring reads.
 */
function isScorableRecord(raw: string, comment?: string): boolean {
  if (comment && raw.startsWith(comment)) {
    return false;
  }
  return raw.trim() !== "";
}

export interface DelimiterDetectorOptions {
  /** Quote character, or "" when quoting is disabled. */
  quote?: string;
  escape?: string;
  relaxQuotes?: boolean;
  comment?: string;
  delimitersToGuess?: readonly string[];
  /**
   * Record separator, when the parse will actually end records at one.
   *
   * Only fastMode does; standard mode always ends records at CR/LF, so passing it there would
   * sample on boundaries the parser never uses.
   */
  lineEnding?: string;
}

export interface DelimiterDetector {
  /** Add text. Only the arriving text is examined; nothing is retained for a second pass. */
  feed(text: string): void;

  /** Start over from `text`, for a hook that rewrote the input. */
  reset(text: string): void;

  /**
   * The delimiter, or undefined while more text could still change the answer.
   *
   * Undefined means "wait": every candidate must hold a full sample, or have shown it cannot
   * complete another record, before a decision is stable enough to commit to.
   */
  decide(): string | undefined;

  /** The delimiter, given that no more text is coming. */
  decideAtEof(): string;

  /** Release per-candidate state once the delimiter is settled. Further feeds are ignored. */
  release(): void;
}

/** What one candidate has made of the text so far. */
interface Candidate {
  /** Undefined for the configured-separator path, where records are split without a scanner. */
  scanner: Scanner | undefined;
  config: ScannerConfig;
  /** Field counts of the scorable records this candidate has completed, capped at the sample. */
  fieldCounts: number[];
  /** Characters of those scorable records. */
  scoredChars: number;
  /** Characters of every record consumed, scorable or not. */
  consumedChars: number;
}

export function createDelimiterDetector(options: DelimiterDetectorOptions): DelimiterDetector {
  const quote = options.quote ?? '"';
  const comment = options.comment;
  const separator = options.lineEnding;
  /** Records split by a configured separator rather than by the CSV grammar. */
  const useSeparator = separator !== undefined && separator !== "";
  const candidateDelimiters = delimiterCandidates(options.delimitersToGuess);

  const configFor = (delimiter: string): ScannerConfig => ({
    delimiter,
    quote,
    escape: options.escape ?? quote,
    quoteEnabled: quote !== "",
    relaxQuotes: options.relaxQuotes ?? false
  });

  let candidates: Candidate[] = [];
  /** Total characters fed, so that undigested text can be measured without keeping it. */
  let fedChars = 0;
  /** The record being accumulated on the configured-separator path, which may span chunks. */
  let pendingRecord = "";
  let released = false;
  /** The answer once given, so that a call after `release` cannot report a different one. */
  let settled: string | undefined;

  function build(): void {
    candidates = candidateDelimiters.map(delimiter => ({
      scanner: useSeparator ? undefined : createScanner(configFor(delimiter)),
      config: configFor(delimiter),
      fieldCounts: [],
      scoredChars: 0,
      consumedChars: 0
    }));
    fedChars = 0;
    pendingRecord = "";
  }

  build();

  /** Whether this candidate has all the sample it will be scored on. */
  const hasFullSample = (candidate: Candidate): boolean =>
    candidate.fieldCounts.length >= SAMPLE_RECORDS || candidate.scoredChars >= SAMPLE_CHARS;

  /**
   * Whether this candidate has stopped being able to complete records.
   *
   * Checked only after its scanner has been drained, so undigested text really is text the
   * candidate cannot turn into a record — a quoted field its grammar never closes. Checking it
   * before draining made any first chunk of this size look stuck, which decided the delimiter
   * on however much text happened to arrive first.
   */
  const isStuck = (candidate: Candidate): boolean =>
    fedChars - candidate.consumedChars >= SAMPLE_CHARS;

  function countRecord(candidate: Candidate, raw: string, consumed: number): void {
    candidate.consumedChars += consumed;
    if (!isScorableRecord(raw, comment)) {
      return;
    }
    candidate.fieldCounts.push(scanRow(raw, 0, candidate.config, true).fields.length);
    candidate.scoredChars += raw.length;
  }

  function feedSeparatorPath(data: string): void {
    pendingRecord += data;
    let at = pendingRecord.indexOf(separator as string);
    while (at !== -1) {
      const raw = pendingRecord.slice(0, at);
      const consumed = at + (separator as string).length;
      for (const candidate of candidates) {
        if (!hasFullSample(candidate)) {
          countRecord(candidate, raw, consumed);
        } else {
          candidate.consumedChars += consumed;
        }
      }
      pendingRecord = pendingRecord.slice(consumed);
      at = pendingRecord.indexOf(separator as string);
    }
  }

  function feed(data: string): void {
    if (released || data === "") {
      return;
    }
    fedChars += data.length;

    if (useSeparator) {
      feedSeparatorPath(data);
      return;
    }

    for (const candidate of candidates) {
      const scanner = candidate.scanner;
      if (!scanner) {
        continue;
      }
      scanner.feed(data);
      // Drained fully even once the sample is full, so that `consumedChars` keeps pace with the
      // text and a candidate that is merely finished is never mistaken for one that is stuck.
      let row = scanner.nextRow();
      while (row !== null) {
        const raw = row.raw ?? "";
        const consumed = raw.length + (row.newline?.length ?? 0);
        if (hasFullSample(candidate)) {
          candidate.consumedChars += consumed;
        } else {
          countRecord(candidate, raw, consumed);
        }
        row = scanner.nextRow();
      }
    }
  }

  /** Take the trailing record, which has no terminator and so is only a record at end of input. */
  function drainFinalRecords(): void {
    if (useSeparator) {
      if (pendingRecord !== "") {
        const raw = pendingRecord;
        for (const candidate of candidates) {
          if (!hasFullSample(candidate)) {
            countRecord(candidate, raw, raw.length);
          }
        }
        pendingRecord = "";
      }
      return;
    }

    for (const candidate of candidates) {
      let row = candidate.scanner?.flush() ?? null;
      while (row !== null) {
        const raw = row.raw ?? "";
        if (!hasFullSample(candidate)) {
          countRecord(candidate, raw, raw.length + (row.newline?.length ?? 0));
        }
        row = candidate.scanner?.flush() ?? null;
      }
    }
  }

  /** Pick the candidate whose field counts are most consistent, then most numerous. */
  function score(): string | undefined {
    let best: string | undefined;
    let bestDelta: number | undefined;
    let bestAverage: number | undefined;

    for (let index = 0; index < candidates.length; index++) {
      const counts = candidates[index].fieldCounts;
      if (counts.length === 0) {
        continue;
      }

      let delta = 0;
      let total = 0;
      let previous: number | undefined;
      for (const count of counts) {
        total += count;
        if (previous !== undefined) {
          delta += Math.abs(count - previous);
        }
        previous = count;
      }
      const average = total / counts.length;
      if (average <= MIN_AVERAGE_FIELDS) {
        continue;
      }

      if (
        bestDelta === undefined ||
        delta < bestDelta ||
        (delta === bestDelta && (bestAverage === undefined || average > bestAverage))
      ) {
        bestDelta = delta;
        bestAverage = average;
        best = candidateDelimiters[index];
      }
    }

    return best;
  }

  /**
   * Whether waiting could still change the answer.
   *
   * Every candidate must have its full sample or have shown it cannot complete another record,
   * and at least one scorable record must exist — committing on a partial first line is what
   * once made a stream pick comma for a semicolon-delimited file.
   */
  function isReady(): boolean {
    let anyScorable = false;
    for (const candidate of candidates) {
      if (!hasFullSample(candidate) && !isStuck(candidate)) {
        return false;
      }
      if (candidate.fieldCounts.length > 0) {
        anyScorable = true;
      }
    }
    return anyScorable;
  }

  return {
    feed,

    reset(text: string): void {
      released = false;
      build();
      feed(text);
    },

    decide(): string | undefined {
      if (released || !isReady()) {
        return undefined;
      }
      settled = score();
      return settled;
    },

    decideAtEof(): string {
      if (released) {
        return settled ?? candidateDelimiters[0];
      }
      drainFinalRecords();
      settled = score() ?? candidateDelimiters[0];
      return settled;
    },

    release(): void {
      released = true;
      candidates = [];
      fedChars = 0;
      pendingRecord = "";
    }
  };
}

/** Detect from text already in hand, which is the batch case. */
export function detectDelimiterFor(input: string, options: DelimiterDetectorOptions): string {
  const detector = createDelimiterDetector(options);
  detector.feed(input);
  return detector.decideAtEof();
}
