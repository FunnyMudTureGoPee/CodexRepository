/**
 * Search index for the Plugin Insight tab (CONTRACT.md §3.4).
 *
 * A dependency-free, deterministic simplification of the official Discover search:
 *   - text is NFKC-normalized and lowercased;
 *   - tokens are runs of letters, digits and marks; CJK runs are expanded into
 *     overlapping bigrams plus the trailing single character;
 *   - a query term hits when it is a prefix of an indexed term, and — for query terms
 *     of four or more code points — when its Levenshtein distance to the indexed term
 *     is at most max(1, round(length / 5));
 *   - a query matches an entry only when every query term hits it;
 *   - field weights name/title = 3, category = 2, description = 1.
 *
 * `segment`, `buildIndex` and `matchText` are the frozen exports (§3.4). The module
 * has no imports, never mutates its inputs, and returns the same result for the same
 * input on every call.
 */

/* -------------------------------------------------------------------------- */
/* Segmentation                                                               */
/* -------------------------------------------------------------------------- */

/** Letter, digit or combining mark (everything that belongs to a word token). */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
/** CJK ideographs, kana and Hangul — the scripts that use no inter-word spaces. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Field weights: name and title are the strongest signals (CONTRACT §3.4). */
export const FIELD_WEIGHTS = Object.freeze({ name: 3, title: 3, category: 2, description: 1 });

const FUZZY_MIN_LENGTH = 4;

/** NFKC + lowercase; non-string values become the empty string. */
function normalizeText(text) {
  return typeof text === 'string' ? text.normalize('NFKC').toLowerCase() : '';
}

/** Number of Unicode code points (deterministic length for edit distance / buckets). */
function codePointLength(text) {
  let length = 0;
  for (const _char of text) length += 1;
  return length;
}

/** Append a CJK run as overlapping bigrams plus the trailing single character. */
function pushCjkTokens(run, tokens) {
  const chars = [...run];
  if (chars.length === 1) {
    tokens.push(chars[0]);
    return;
  }
  for (let index = 0; index + 1 < chars.length; index++) tokens.push(chars[index] + chars[index + 1]);
  tokens.push(chars[chars.length - 1]);
}

/**
 * Split text into normalized search terms.
 *
 * Latin/digit runs stay whole (`dsh-plugin-memory` → `dsh`, `plugin`, `memory`);
 * each CJK run becomes overlapping bigrams plus its trailing character
 * (`记忆系统` → `记忆`, `忆系`, `系统`, `统`).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function segment(text) {
  const value = normalizeText(text);
  if (value === '') return [];
  const tokens = [];
  let run = '';
  let runIsCjk = false;
  const flush = () => {
    if (run === '') return;
    if (runIsCjk) pushCjkTokens(run, tokens);
    else tokens.push(run);
    run = '';
  };
  let first = true;
  for (const char of value) {
    if (!WORD_CHAR.test(char)) {
      flush();
      first = true;
      continue;
    }
    const isCjk = CJK_CHAR.test(char);
    if (!first && isCjk !== runIsCjk) flush();
    runIsCjk = isCjk;
    run += char;
    first = false;
  }
  flush();
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Index building                                                             */
/* -------------------------------------------------------------------------- */

/** Accept a plain string or a `{ en, zh }` localized object. */
function addFieldTerms(target, field, weight) {
  const collect = (text) => {
    if (typeof text !== 'string' || text === '') return;
    for (const term of segment(text)) {
      const previous = target.get(term);
      if (previous === undefined || previous < weight) target.set(term, weight);
    }
  };
  if (typeof field === 'string') {
    collect(field);
  } else if (field !== null && typeof field === 'object') {
    collect(field.en);
    collect(field.zh);
  }
}

/**
 * Build the search index for normalized entries.
 *
 * @param {Array<{ name?: string, title?: string|{en?: string, zh?: string}, description?: string|{en?: string, zh?: string}, categoryTitle?: string|{en?: string, zh?: string} }>} entries
 * @returns {{ entryCount: number, terms: string[], postings: Map<string, number[]>, byLength: Map<number, string[]> }}
 */
export function buildIndex(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const entryCount = list.length;
  /** @type {Map<string, number[]>} term → postings of `(entryIndex << 2) | weight` */
  const postings = new Map();
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    const entry = list[entryIndex] === null || typeof list[entryIndex] !== 'object' ? {} : list[entryIndex];
    /** @type {Map<string, number>} */
    const weights = new Map();
    addFieldTerms(weights, entry.name, FIELD_WEIGHTS.name);
    addFieldTerms(weights, entry.title, FIELD_WEIGHTS.title);
    addFieldTerms(weights, entry.categoryTitle, FIELD_WEIGHTS.category);
    addFieldTerms(weights, entry.description, FIELD_WEIGHTS.description);
    for (const [term, weight] of weights) {
      let posting = postings.get(term);
      if (posting === undefined) {
        posting = [];
        postings.set(term, posting);
      }
      posting.push((entryIndex << 2) | weight);
    }
  }
  const terms = [...postings.keys()].sort();
  const byLength = new Map();
  for (const term of terms) {
    const length = codePointLength(term);
    let bucket = byLength.get(length);
    if (bucket === undefined) {
      bucket = [];
      byLength.set(length, bucket);
    }
    bucket.push(term);
  }
  return { entryCount, terms, postings, byLength };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

/** First index whose term is not lexicographically smaller than `term`. */
function lowerBound(sortedTerms, term) {
  let low = 0;
  let high = sortedTerms.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedTerms[middle] < term) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Bounded Levenshtein distance check. Only answers "is the distance ≤ maxDistance",
 * which lets the common case bail out after the first expensive row.
 */
function editDistanceWithin(left, right, maxDistance) {
  const a = [...left];
  const b = [...right];
  const aLength = a.length;
  const bLength = b.length;
  if (Math.abs(aLength - bLength) > maxDistance) return false;
  if (left === right) return true;
  // Banded DP: |i - j| must stay within maxDistance or no edit script fits.
  const width = bLength + 1;
  let previous = new Int32Array(width);
  let current = new Int32Array(width);
  const unreachable = maxDistance + 1;
  for (let j = 0; j <= bLength; j++) previous[j] = j <= maxDistance ? j : unreachable;
  for (let i = 1; i <= aLength; i++) {
    current.fill(unreachable);
    const from = Math.max(1, i - maxDistance);
    const to = Math.min(bLength, i + maxDistance);
    current[0] = i <= maxDistance ? i : unreachable;
    if (from > 1) current[from - 1] = unreachable;
    let rowMinimum = current[0];
    for (let j = from; j <= to; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      let value = substitution < deletion ? substitution : deletion;
      if (insertion < value) value = insertion;
      current[j] = value;
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > maxDistance) return false;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[bLength] <= maxDistance;
}

/** Merge one term's postings into the per-entry score map, keeping the strongest field. */
function addPosting(scores, posting) {
  if (posting === undefined) return;
  for (let index = 0; index < posting.length; index++) {
    const encoded = posting[index];
    const entryIndex = encoded >>> 2;
    const weight = encoded & 3;
    const previous = scores.get(entryIndex);
    if (previous === undefined || weight > previous) scores.set(entryIndex, weight);
  }
}

/** Collect every entry a single query term hits, with the best field weight. */
function termMatches(index, queryTerm) {
  /** @type {Map<number, number>} */
  const scores = new Map();
  // Prefix match over the lexicographically sorted term list.
  const start = lowerBound(index.terms, queryTerm);
  for (let position = start; position < index.terms.length; position++) {
    const term = index.terms[position];
    if (!term.startsWith(queryTerm)) break;
    addPosting(scores, index.postings.get(term));
  }
  // Fuzzy match for query terms long enough to afford a typo.
  const length = codePointLength(queryTerm);
  if (length >= FUZZY_MIN_LENGTH) {
    const maxDistance = Math.max(1, Math.round(length / 5));
    for (let candidateLength = length - maxDistance; candidateLength <= length + maxDistance; candidateLength++) {
      if (candidateLength <= 0) continue;
      const bucket = index.byLength.get(candidateLength);
      if (bucket === undefined) continue;
      for (const term of bucket) {
        if (term.startsWith(queryTerm)) continue; // already collected by the prefix scan
        if (editDistanceWithin(queryTerm, term, maxDistance)) addPosting(scores, index.postings.get(term));
      }
    }
  }
  return scores;
}

/**
 * Score entries against a free-text query.
 *
 * The result is `Map<entryIndex, score>` where score is the sum of the strongest field
 * weight each query term hits (name/title 3, category 2, description 1). A query whose
 * terms do not all hit an entry excludes it. A query without any letter/number/mark
 * returns every entry with score 0 (CONTRACT §3.4).
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} text
 * @returns {Map<number, number>}
 */
export function matchText(index, text) {
  const queryTerms = segment(text);
  /** @type {Map<number, number>} */
  const scores = new Map();
  if (queryTerms.length === 0) {
    for (let entryIndex = 0; entryIndex < index.entryCount; entryIndex++) scores.set(entryIndex, 0);
    return scores;
  }
  let first = true;
  for (const queryTerm of queryTerms) {
    const hits = termMatches(index, queryTerm);
    if (first) {
      for (const [entryIndex, score] of hits) scores.set(entryIndex, score);
      first = false;
    } else {
      for (const entryIndex of [...scores.keys()]) {
        const score = hits.get(entryIndex);
        if (score === undefined) scores.delete(entryIndex);
        else scores.set(entryIndex, scores.get(entryIndex) + score);
      }
    }
    if (scores.size === 0) break;
  }
  return scores;
}
