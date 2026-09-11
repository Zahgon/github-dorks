// Stands in for Python's built-in str() and repr().
//
// github-dork.py never calls either by name, but both are load-bearing: the csv
// writer coerces every non-string field with str(), and the print path
// interpolates `{text_matches}` -- a list -- into a template with str.format().
// str() of a container is repr() of that container, and repr() of a container
// renders its elements with repr(). So the CSV column that holds a search
// result's text matches is Python's list repr, not a comma-joined string, and
// reproducing it is the difference between the port's output and the
// original's.
//
// Every rule below was captured by executing CPython 3.11, not read off the
// language reference; see ../../github-dorks-parity-harness/probe_repr.py.

// Python's str.isprintable(): "Nonprintable characters are those characters
// defined in the Unicode character database as 'Other' or 'Separator',
// excepting the ASCII space (0x20)."
const NONPRINTABLE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function isPrintable(codePoint) {
  if (codePoint === 0x20) return true; // ASCII space is the documented exception
  return !NONPRINTABLE.test(String.fromCodePoint(codePoint));
}

function hex(codePoint, width) {
  return codePoint.toString(16).padStart(width, '0');
}

// repr() of a str. Python prefers single quotes and switches to double quotes
// only when the string contains a single quote and no double quote; the chosen
// quote is then the only one that needs escaping.
export function reprString(value) {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (ch === '\\' || ch === quote) out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (isPrintable(cp)) out += ch;
    else if (cp < 0x100) out += '\\x' + hex(cp, 2);
    else if (cp < 0x10000) out += '\\u' + hex(cp, 4);
    else out += '\\U' + hex(cp, 8);
  }
  return out + quote;
}

// repr() of a float. CPython emits the shortest string that round-trips, then
// picks fixed or scientific notation from the decimal point position: notation
// is scientific when decpt <= -4 or decpt > 16, and a fixed-notation result
// that would otherwise look like an integer gains a trailing '.0'. JavaScript's
// own Number->String uses different thresholds (1e21 and 1e-7), so the choice
// has to be made here rather than delegated to String(n).
export function reprFloat(value) {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';

  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  if (magnitude === 0) return negative ? '-0.0' : '0.0';

  // toExponential() with no argument is specified to use "as many digits as
  // necessary to uniquely specify the number" -- the same shortest round-trip
  // digit string CPython computes.
  const [mantissa, exponent] = magnitude.toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const decpt = Number(exponent) + 1;
  const sign = negative ? '-' : '';

  if (decpt <= -4 || decpt > 16) {
    const head = digits.length > 1
      ? digits[0] + '.' + digits.slice(1)
      : digits;
    const e = decpt - 1;
    const eSign = e < 0 ? '-' : '+';
    return sign + head + 'e' + eSign + String(Math.abs(e)).padStart(2, '0');
  }
  if (decpt <= 0) return sign + '0.' + '0'.repeat(-decpt) + digits;
  if (decpt >= digits.length) {
    return sign + digits + '0'.repeat(decpt - digits.length) + '.0';
  }
  return sign + digits.slice(0, decpt) + '.' + digits.slice(decpt);
}

// A JavaScript number carries no int/float distinction, so this port renders a
// number with Python's int rules exactly when it holds an integral value. See
// the "Necessary differences" section of MIGRATION.md: 42.0 is not
// representable as distinct from 42 here, and renders as the latter. Use
// pyFloat() to force the float rendering where the distinction matters.
const FLOAT = Symbol('python-float');

export function pyFloat(value) {
  return { [FLOAT]: Number(value) };
}

export function isPyFloat(value) {
  return typeof value === 'object' && value !== null && FLOAT in value;
}

export function reprNumber(value) {
  if (Number.isInteger(value) && Number.isFinite(value)) return String(value);
  return reprFloat(value);
}

// repr(). str() and repr() differ only for strings; for everything the source
// can hand to the csv writer, str(x) is repr(x) except when x is already a str.
export function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (isPyFloat(value)) return reprFloat(value[FLOAT]);
  if (typeof value === 'string') return reprString(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return reprNumber(value);
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return '[' + value.map(pyRepr).join(', ') + ']';
  if (value instanceof Map) return reprPairs(value.entries());
  if (value instanceof Set) {
    // Python renders the empty set as set(), not {}, because {} is a dict.
    const items = [...value].map(pyRepr);
    return items.length ? '{' + items.join(', ') + '}' : 'set()';
  }
  if (typeof value === 'object') return reprPairs(Object.entries(value));
  return String(value);
}

function reprPairs(entries) {
  const parts = [];
  for (const [key, val] of entries) {
    parts.push(pyRepr(key) + ': ' + pyRepr(val));
  }
  return '{' + parts.join(', ') + '}';
}

export function pyStr(value) {
  if (typeof value === 'string') return value;
  return pyRepr(value);
}

// str.strip(). Python's whitespace set includes the C1 separators \x1c-\x1f
// and \x85 and excludes the byte-order mark; JavaScript's String.trim() is the
// other way round on both counts. The dork-line filter reads the first
// character of the stripped line, so a dictionary whose first line carries a
// BOM takes a different branch under each.
const PY_SPACE =
  '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const STRIP = new RegExp(`^${PY_SPACE}+|${PY_SPACE}+$`, 'gu');

export function pyStrip(text) {
  return text.replace(STRIP, '');
}

// str.splitlines(). Eleven characters end a line, not one: JavaScript's
// split(/\n/) misses the vertical tab, the form feed, the three information
// separators, NEL and the two Unicode separators, and it leaves a trailing
// empty string that splitlines does not produce. The migrated suite splits the
// dork dictionary with this, so a dictionary carrying any of them would be
// counted differently under each.
const LINE_BOUNDARY = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;

export function pySplitlines(text) {
  if (text === '') return [];
  const parts = text.split(new RegExp(LINE_BOUNDARY, 'u'));
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
