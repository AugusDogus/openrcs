import { Result, TaggedError } from "better-result";

/**
 * In-memory text matching for decrypted rows (there is no plaintext index).
 * Matching is case- and diacritic-insensitive (NFKD, combining marks
 * stripped). Every term must appear in at least one field; `"quoted text"` is
 * one term matched as a phrase. Terms that look like phone numbers also match
 * the digits of number fields, so "5551234" finds "+1 (555) 123-4567".
 */
export type SearchTerm = {
  /** Normalized text, whitespace collapsed. */
  readonly text: string;
  /** Digits of the term when it looks like a phone number (>= 3 digits), else null. */
  readonly digits: string | null;
};

export type SearchQuery = { readonly raw: string; readonly terms: readonly SearchTerm[] };

/** Text fields to search, plus number fields that also match by digits. */
export type SearchFields = {
  readonly text: readonly (string | null)[];
  readonly numbers: readonly (string | null)[];
};

export class SearchQueryError extends TaggedError("SearchQueryError")<{ message: string }> {}

const MAX_TERMS = 16;

const normalize = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const digitsOf = (value: string): string => value.replace(/\D+/g, "");

const phoneLike = /^\+?[\d\s().-]+$/;

const toTerm = (raw: string): SearchTerm | null => {
  const text = normalize(raw);
  if (text === "") return null;
  const digits = digitsOf(raw);
  return { text, digits: phoneLike.test(raw.trim()) && digits.length >= 3 ? digits : null };
};

const parse = (raw: string): Result<SearchQuery, SearchQueryError> => {
  const terms: SearchTerm[] = [];
  for (const match of raw.matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = toTerm(match[1] ?? match[2] ?? "");
    if (term !== null) terms.push(term);
  }
  if (terms.length === 0) {
    return Result.err(
      new SearchQueryError({
        message: 'The search query is empty. Pass one or more words, or a "quoted phrase".',
      }),
    );
  }
  if (terms.length > MAX_TERMS) {
    return Result.err(
      new SearchQueryError({
        message: `The search query has ${terms.length} terms; use at most ${MAX_TERMS}.`,
      }),
    );
  }
  return Result.ok({ raw, terms });
};

/** Prepared haystacks for one row, so each term is checked without re-normalizing. */
export type PreparedFields = { readonly text: string; readonly digits: readonly string[] };

const prepare = (fields: SearchFields): PreparedFields => ({
  text: fields.text
    .filter((value): value is string => value !== null && value !== "")
    .map(normalize)
    .join("\n"),
  digits: fields.numbers
    .filter((value): value is string => value !== null && value !== "")
    .map(digitsOf)
    .filter((value) => value !== ""),
});

const termMatches = (term: SearchTerm, fields: PreparedFields): boolean => {
  if (fields.text.includes(term.text)) return true;
  const digits = term.digits;
  return digits !== null && fields.digits.some((number) => number.includes(digits));
};

const matches = (query: SearchQuery, fields: SearchFields | PreparedFields): boolean => {
  const prepared = "numbers" in fields ? prepare(fields) : fields;
  return query.terms.every((term) => termMatches(term, prepared));
};

export const SearchQuery = {
  parse,
  normalize,
  prepare,
  matches,
} as const;
