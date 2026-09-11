// Stands in for textwrap, for the two calls argparse makes into it: wrap() for
// every help string and fill() for the description and the epilog.
//
// argparse does not lay out help text itself, so the column at which a help
// line breaks is decided here, and textwrap's rules are not the obvious ones.
// It splits *after* an interior hyphen, so 'techgaun/github-dorks' can become
// 'techgaun/github-' plus 'dorks' but 'x-1' can never be split; it expands tabs
// against a column counter before measuring anything; and it drops leading
// whitespace on every line except the first. Reproducing the wrapping without
// reproducing these produces help output that differs from the original's on
// exactly the strings this repository ships.
//
// Every rule below was captured by executing CPython 3.11, and the port is
// diffed against that capture; see
// ../../github-dorks-parity-harness/probe_textwrap.py.

import { PyValueError } from './pyerrors.js';

// Python's re character classes, spelled for JavaScript's Unicode mode. Python's
// \w for str is alphanumerics plus underscore, and [^\d\W] is that set minus the
// decimal digits -- neither is JavaScript's ASCII-only \w.
const WS = '[\\t\\n\\v\\f\\r ]';
const NWS = '[^\\t\\n\\v\\f\\r ]';
const WORD = '[\\p{L}\\p{N}_]';
const LETTER = '[\\p{L}\\p{Nl}\\p{No}_]';
const WORD_PUNCT = '[\\p{L}\\p{N}_!"\'&.,?]';

// TextWrapper.wordsep_re. The middle alternative is the hyphen rule: a hyphen
// is a split point only when at least two letters precede it and a letter
// follows, which is what keeps 'x-1' and '-leading' whole.
const WORDSEP = new RegExp(
  '(' +
    `${WS}+` +
    '|' +
    `(?<=${WORD_PUNCT})-{2,}(?=${WORD})` +
    '|' +
    `${NWS}+?(?:` +
      `-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})` +
      '|' +
      `(?=${WS}|$)` +
      '|' +
      `(?<=${WORD_PUNCT})(?=-{2,}${WORD})` +
    ')' +
  ')',
  'u',
);

const WORDSEP_SIMPLE = /([\t\n\v\f\r ]+)/u;

// Python measures strings in code points and JavaScript in UTF-16 units, so a
// help string containing an astral character would wrap at a different column
// if the port used .length.
const chars = (text) => [...text];
const width = (text) => chars(text).length;

const isBlank = (chunk) => chunk.trim() === '';

// str.expandtabs(): a tab advances to the next multiple of tabsize, counting
// from the last line break rather than from the start of the string.
function expandTabs(text, tabsize) {
  let out = '';
  let column = 0;
  for (const ch of text) {
    if (ch === '\t') {
      if (tabsize > 0) {
        const spaces = tabsize - (column % tabsize);
        out += ' '.repeat(spaces);
        column += spaces;
      }
      continue;
    }
    out += ch;
    if (ch === '\n' || ch === '\r') column = 0;
    else column += 1;
  }
  return out;
}

function rfind(codePoints, target, end) {
  for (let i = Math.min(end, codePoints.length) - 1; i >= 0; i -= 1) {
    if (codePoints[i] === target) return i;
  }
  return -1;
}

export class TextWrapper {
  constructor({
    width: lineWidth = 70,
    initialIndent = '',
    subsequentIndent = '',
    expandTabs: doExpandTabs = true,
    replaceWhitespace = true,
    breakLongWords = true,
    dropWhitespace = true,
    breakOnHyphens = true,
    tabsize = 8,
  } = {}) {
    this.width = lineWidth;
    this.initialIndent = initialIndent;
    this.subsequentIndent = subsequentIndent;
    this.expandTabs = doExpandTabs;
    this.replaceWhitespace = replaceWhitespace;
    this.breakLongWords = breakLongWords;
    this.dropWhitespace = dropWhitespace;
    this.breakOnHyphens = breakOnHyphens;
    this.tabsize = tabsize;
  }

  munge(text) {
    let munged = text;
    if (this.expandTabs) munged = expandTabs(munged, this.tabsize);
    if (this.replaceWhitespace) munged = munged.replace(/[\t\n\v\f\r]/gu, ' ');
    return munged;
  }

  // _split(). JavaScript's String.split splices capture groups into its result
  // exactly as Python's re.split does, so the separators survive as chunks.
  split(text) {
    const pattern = this.breakOnHyphens ? WORDSEP : WORDSEP_SIMPLE;
    return text.split(pattern).filter((chunk) => chunk !== '' && chunk !== undefined);
  }

  handleLongWord(reversedChunks, curLine, curLen, lineWidth) {
    const spaceLeft = lineWidth < 1 ? 1 : lineWidth - curLen;

    if (!this.breakLongWords) {
      if (curLine.length === 0) curLine.push(reversedChunks.pop());
      return;
    }

    const chunk = chars(reversedChunks[reversedChunks.length - 1]);
    let end = spaceLeft;
    if (this.breakOnHyphens && chunk.length > spaceLeft) {
      // Break after the last hyphen that fits, but only when something other
      // than hyphens precedes it.
      const hyphen = rfind(chunk, '-', spaceLeft);
      if (hyphen > 0 && chunk.slice(0, hyphen).some((c) => c !== '-')) end = hyphen + 1;
    }
    curLine.push(chunk.slice(0, end).join(''));
    reversedChunks[reversedChunks.length - 1] = chunk.slice(end).join('');
  }

  wrapChunks(chunks) {
    if (this.width <= 0) {
      throw new PyValueError(`invalid width ${this.width} (must be > 0)`);
    }

    const lines = [];
    const remaining = chunks.slice().reverse();

    while (remaining.length) {
      const curLine = [];
      let curLen = 0;
      const indent = lines.length ? this.subsequentIndent : this.initialIndent;
      const lineWidth = this.width - width(indent);

      // Leading whitespace is dropped on every line but the first.
      if (this.dropWhitespace && isBlank(remaining[remaining.length - 1]) && lines.length) {
        remaining.pop();
      }

      while (remaining.length) {
        const chunkWidth = width(remaining[remaining.length - 1]);
        if (curLen + chunkWidth > lineWidth) break;
        curLine.push(remaining.pop());
        curLen += chunkWidth;
      }

      if (remaining.length && width(remaining[remaining.length - 1]) > lineWidth) {
        this.handleLongWord(remaining, curLine, curLen, lineWidth);
        curLen = curLine.reduce((total, chunk) => total + width(chunk), 0);
      }

      if (this.dropWhitespace && curLine.length && isBlank(curLine[curLine.length - 1])) {
        curLen -= width(curLine[curLine.length - 1]);
        curLine.pop();
      }

      if (curLine.length) lines.push(indent + curLine.join(''));
    }

    return lines;
  }

  wrap(text) {
    return this.wrapChunks(this.split(this.munge(text)));
  }

  fill(text) {
    return this.wrap(text).join('\n');
  }
}

export function wrap(text, lineWidth = 70, options = {}) {
  return new TextWrapper({ ...options, width: lineWidth }).wrap(text);
}

export function fill(text, lineWidth = 70, options = {}) {
  return new TextWrapper({ ...options, width: lineWidth }).fill(text);
}
