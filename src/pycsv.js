// Stands in for Python's csv module, restricted to the one thing github-dork.py
// uses: csv.writer(f) with the default 'excel' dialect, and writerow().
//
// The CSV file this tool writes is its machine-readable output, so the port has
// to produce the same bytes rather than merely a well-formed CSV. Three of the
// excel dialect's rules differ from what an ad-hoc join would do, and each one
// is reachable from real GitHub search results:
//
//   * rows end with CRLF, not LF, even on Unix;
//   * a quote inside a field is doubled, not backslash-escaped;
//   * a row whose single field is empty is written as a pair of quotes,
//     while a row of two empty fields is written as a bare delimiter.
//
// Every rule below was captured by executing CPython 3.11, not read off the
// module documentation; see ../../github-dorks-parity-harness/probe_primitives.py
// sections A, B and the empty-field table.

import { PyError } from './pyerrors.js';
import { pyStr } from './pystr.js';

// csv.excel, as reported by the dialect object itself.
export const EXCEL = {
  delimiter: ',',
  quotechar: '"',
  doublequote: true,
  escapechar: null,
  lineterminator: '\r\n',
  quoting: 0, // QUOTE_MINIMAL
  skipinitialspace: false,
};

// _csv.c coerces each field before quoting: None becomes the empty string, a
// float is rendered with repr() and everything else with str(). str() of a str
// is the string itself, which is why a field is never quoted for containing an
// apostrophe.
export function fieldToString(value) {
  if (value === null || value === undefined) return '';
  return pyStr(value);
}

// QUOTE_MINIMAL: quote when the field contains the delimiter, the quote
// character, or any character of the line terminator. The escapechar branch of
// _csv.c is unreachable here because the excel dialect has no escape character.
function needsQuoting(field, dialect) {
  for (const ch of field) {
    if (
      ch === dialect.delimiter ||
      ch === dialect.quotechar ||
      dialect.lineterminator.includes(ch)
    ) {
      return true;
    }
  }
  return false;
}

function formatField(field, dialect) {
  if (!needsQuoting(field, dialect)) return field;
  const doubled = dialect.doublequote
    ? field.split(dialect.quotechar).join(dialect.quotechar + dialect.quotechar)
    : field;
  return dialect.quotechar + doubled + dialect.quotechar;
}

// The record one writerow() call appends, line terminator included.
export function formatRow(fields, dialect = EXCEL) {
  const rendered = [...fields].map((field) => fieldToString(field));
  const parts = rendered.map((field) => formatField(field, dialect));

  // _csv.c's "handle the case of a single empty field": a row that would
  // otherwise be written as nothing at all is written as an empty quoted field
  // instead, so that a reader sees one field rather than none. The check is on
  // the whole record being empty, so it does not fire for two empty fields --
  // that record is a bare delimiter, and reads back as two empty fields.
  if (parts.length === 1 && parts[0] === '') {
    return dialect.quotechar + dialect.quotechar + dialect.lineterminator;
  }
  return parts.join(dialect.delimiter) + dialect.lineterminator;
}

// csv.writer(fileobj). The Python object exposes writerow/writerows/dialect;
// this exposes the same, over anything with a write() method. The source opens
// its file with newline='' so that the writer's CRLF reaches the file
// untranslated; Node performs no such translation, so nothing here corresponds
// to that argument. See MIGRATION.md.
export function writer(stream, dialect = EXCEL) {
  return {
    dialect,
    writerow(fields) {
      const record = formatRow(fields, dialect);
      stream.write(record);
      return record;
    },
    writerows(rows) {
      for (const row of rows) this.writerow(row);
    },
  };
}

// csv.reader. github-dork.py never reads a CSV back; its suite does, to check
// what the tool wrote, so what this returns decides what the migrated suite
// asserts against. Reading is not the inverse of splitting on commas: a quoted
// field carries its own line breaks through into the value, a doubled quote
// collapses to one, an unterminated quoted field swallows the rest of the
// input, and a line holding nothing but a terminator yields a record with no
// fields at all while empty input yields no record. Captured by executing
// CPython 3.11; see ../../github-dorks-parity-harness/probe_reader.py.

const QUOTE_NONE = 3;

// The reader consumes its input one line at a time, and a line ends at CR, LF
// or CRLF with its terminator retained. That is readline's rule, not
// splitlines' -- the vertical tab and the Unicode separators end a line for
// str.splitlines and not for a file being read.
function readLinesKeepEnds(text) {
  const lines = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\r') {
      const end = text[i + 1] === '\n' ? i + 2 : i + 1;
      lines.push(text.slice(start, end));
      start = end;
      i = end;
    } else if (ch === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function* reader(input, dialect = EXCEL) {
  const text = typeof input === 'string' ? input : [...input].join('');

  let state = 'START_RECORD';
  let fields = [];
  let field = '';

  const saveField = () => {
    fields.push(field);
    field = '';
  };

  // _csv.c's parse_process_char, with null standing for the '\0' it feeds in
  // at the end of every line. The escapechar states are omitted because the
  // excel dialect has no escape character and the source never builds another.
  const process = (c) => {
    switch (state) {
      case 'START_RECORD':
        if (c === null) break;
        if (c === '\n' || c === '\r') {
          state = 'EAT_CRNL';
          break;
        }
        state = 'START_FIELD';
        // falls through -- a normal character is handled as START_FIELD would
      case 'START_FIELD':
        if (c === null || c === '\n' || c === '\r') {
          saveField();
          state = c === null ? 'START_RECORD' : 'EAT_CRNL';
        } else if (c === dialect.quotechar && dialect.quoting !== QUOTE_NONE) {
          state = 'IN_QUOTED_FIELD';
        } else if (c === dialect.delimiter) {
          saveField();
        } else {
          field += c;
          state = 'IN_FIELD';
        }
        break;
      case 'IN_FIELD':
        if (c === null || c === '\n' || c === '\r') {
          saveField();
          state = c === null ? 'START_RECORD' : 'EAT_CRNL';
        } else if (c === dialect.delimiter) {
          saveField();
          state = 'START_FIELD';
        } else {
          field += c;
        }
        break;
      case 'IN_QUOTED_FIELD':
        if (c === null) break;
        if (c === dialect.quotechar && dialect.quoting !== QUOTE_NONE) {
          state = dialect.doublequote ? 'QUOTE_IN_QUOTED_FIELD' : 'IN_FIELD';
        } else {
          field += c;
        }
        break;
      case 'QUOTE_IN_QUOTED_FIELD':
        if (dialect.quoting !== QUOTE_NONE && c === dialect.quotechar) {
          field += c;
          state = 'IN_QUOTED_FIELD';
        } else if (c === dialect.delimiter) {
          saveField();
          state = 'START_FIELD';
        } else if (c === null || c === '\n' || c === '\r') {
          saveField();
          state = c === null ? 'START_RECORD' : 'EAT_CRNL';
        } else {
          field += c;
          state = 'IN_FIELD';
        }
        break;
      case 'EAT_CRNL':
        if (c === '\n' || c === '\r') break;
        if (c === null) {
          state = 'START_RECORD';
          break;
        }
        throw new PyError(
          "new-line character seen in unquoted field - do you need to open the file in universal-newline mode?",
        );
      default:
        throw new PyError(`unknown reader state ${state}`);
    }
  };

  for (const line of readLinesKeepEnds(text)) {
    for (const ch of line) process(ch);
    process(null);
    if (state === 'START_RECORD') {
      yield fields;
      fields = [];
    }
  }

  // The input ran out mid-record. A non-empty buffer or an unclosed quote is
  // saved and returned rather than discarded, because the excel dialect is not
  // strict.
  if (field !== '' || state === 'IN_QUOTED_FIELD') {
    saveField();
    yield fields;
  }
}
