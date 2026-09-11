# Migration record — Python to JavaScript

One section per place the shape had to change. Each says what the original does,
why it cannot be done that way here, what it became, and what preserves the
behaviour across the change. The last two sections list the flaws preserved on
purpose and the differences that remain, so that a later reader does not "fix"
either.

Every claim about the original's behaviour below was obtained by executing it —
CPython 3.11.13, github3.py 4.0.1, feedparser 6.0.14 — not by reading its source
or its documentation. The capture scripts are in `github-dorks-parity-harness/`.

---

## 1. Keyword arguments become an options object

**The original.** `search`, `metasearch` and `monit` each take five or six
keyword parameters with defaults, and all four call sites pass them by name.

**Why not directly.** JavaScript has no keyword arguments. Positional parameters
would compile but would silently reorder at any call site that omitted a middle
argument — and `metasearch` calls `search` positionally while `monit` calls it
by name, so both orders occur in the original.

**What it became.** One options object per function, destructured with the same
parameter names and the same defaults.

**What preserves the behaviour.** The names are unchanged, so each call site
still names what it passes; the defaults are `null` where the original's are
`None`, and the `active_monit === null` test in `metasearch` therefore selects
the same branch. An omitted key destructures to its default exactly as an
omitted keyword argument does.

## 2. Every function that reaches the network is `async`

**The original.** `gh.search_code()` returns an iterator that performs an HTTP
request each time it is advanced, synchronously.

**Why not directly.** Node has no synchronous HTTP. The iterator must page as it
is consumed, so consuming it is asynchronous, and that propagates out through
`searchWrapper` to `search`, `monit` and `metasearch`.

**What preserves the behaviour.** `pyNext()` may return a value or a promise of
one, and every caller awaits it. Awaiting a plain value is a no-op, so the
synchronous iterators the suite and the differential harness inject work
unchanged through the same code path the network iterator uses. Ordering is
unaffected: the original's loop is sequential and every `await` here is too.

## 3. The module-level `gh` moved onto `runtime`

**The original.** `gh` is a module-level name built at import time, and the
suite replaces it with `unittest.mock.patch.object(github_dork, 'gh', client)`.

**Why not directly.** An ES module's exported bindings are read-only from
outside. A test could not replace an exported `gh`, and neither could the
differential harness.

**What it became.** `runtime.gh`, an own property of an exported object, along
with the four environment-derived names beside it.

**What preserves the behaviour.** The value is still constructed at module
evaluation time from the same four environment variables, choosing
`GitHubEnterprise` when `GH_URL` is set and `GitHub` otherwise. `search` and
`searchWrapper` read `runtime.gh` at the point the original reads `gh`, so a
replacement made before the call is seen by it, which is what the suite relies
on.

## 4. `csv.writer` is reimplemented rather than delegated

**The original.** `csv.writer(f)` with the default `excel` dialect.

**Why not directly.** Node ships no CSV writer, and the obvious hand-rolled
join differs from the excel dialect on inputs this tool actually produces:
records end with CRLF rather than LF, an embedded quote is doubled rather than
escaped, and a record whose single field is empty is written as `""` while a
record of two empty fields is written as a bare delimiter.

**What preserves the behaviour.** The dialect's attributes were read off the
dialect object, the quoting rule was reproduced from `_csv.c`'s QUOTE_MINIMAL
branch, and the sole-empty-field special case was reproduced from the same file.
The result is diffed against CPython over a case list covering every kind the
writer can be handed — 253 renderings, all agreeing — and again end-to-end in
the behaviour harness, which compares the CSV file byte for byte.

## 5. `str()` and `repr()` are reimplemented

**The original.** Never calls either by name. It does not have to: the CSV
writer coerces every non-string field with `str()`, and the print path
interpolates a list into a template with `str.format`.

**Why it matters.** `str()` of a list is `repr()` of that list, which renders
its elements with `repr()`. So the "Text Matches" column is Python's list repr —
square brackets, single-quoted elements, `', '` between them — and not a joined
string. `JSON.stringify` produces a different result for every input that
column can hold.

**What preserves the behaviour.** `pyRepr` implements the quote-selection rule
(single quotes unless the string contains one and no double quote), the escape
set, and the `str.isprintable` boundary — which is Unicode's `Other` and
`Separator` categories minus the ASCII space, not JavaScript's notion of
printable. Float rendering follows CPython's shortest-round-trip digits and its
own fixed/scientific threshold, which is not JavaScript's. Checked against the
CPython capture.

## 6. `argparse` is reimplemented

**The original.** Builds a parser with five optional arguments, three of them in
a required mutually exclusive group, and lets argparse produce the usage line,
the help body, the version line and every error message.

**Why not a JS option parser.** That text *is* the CLI. Any other parser
produces different text for all of it — different wrapping, different error
wording, different exit statuses.

**What preserves the behaviour.** The layout algorithm is argparse's: the usage
line assembled from bracketed parts and packed by `_format_usage`'s own
line-filling rule, the help body in argparse's two columns with the help column
at 24, and `HelpFormatter.format_help`'s final pass collapsing runs of newlines.
Three behaviours only a capture revealed are reproduced: the group's members
carry no bracket in the usage line, because `-d` is declared between `-r` and
`-m` and a non-contiguous group loses its usage grouping; an unknown flag is
answered with the group's "is required" error rather than "unrecognized
arguments", because the required-group check runs first; and the width is 78,
because `shutil.get_terminal_size` falls back to 80 whenever output is not a
terminal. Verified by `cli_parity.py`, which drives 27 argument vectors through
both programs and compares exit status, stdout and stderr — normalising only the
program's own name.

## 7. `textwrap` is reimplemented, because argparse depends on it

**The original.** argparse calls `textwrap.wrap` for every help string.

**Why it matters.** textwrap splits *after* an interior hyphen when at least two
letters precede it and a letter follows. That is why
`Github repo to search within. Eg: techgaun/github-dorks` breaks into
`techgaun/github-` and `dorks` rather than wrapping at a space — a visible
feature of this repository's own help output.

**What preserves the behaviour.** `wordsep_re` is transcribed with Python's
character classes spelled for JavaScript's Unicode mode, tabs are expanded
against a column counter before anything is measured, and widths are counted in
code points rather than UTF-16 units. Diffed against the CPython capture: 50/50
cases agree.

## 8. `copy.copy()` on the search iterator

**The original.** `gen_back = copy(gen)` at the top of `search_wrapper`'s loop.

**Why it is not a detail.** What that line does depends on the runtime type of
what `search_code` returned, and there are three different answers, all
reachable. github3's `SearchIterator` keeps its iteration state in an attribute
created lazily by its first `__next__`, so a shallow copy taken *before* that
call restarts from the beginning while one taken *after* shares the generator
and advances it. The `list_iterator` the suite injects copies to an independent
position. A hand-written generator cannot be copied at all — `copy.copy` raises
`TypeError: cannot pickle 'generator' object`.

**What preserves the behaviour.** `copy()` dispatches to a `__copy__`-equivalent
symbol when the value defines one and otherwise performs `copy._copy_inst`'s
shallow own-property copy, so an attribute the original has not created yet is
absent from the copy. `github3.js`'s iterator keeps its state in `__i__`, created
lazily, reproducing the before/after distinction; `PyListIterator` snapshots its
index; `PyGenerator` refuses the copy with the same message.

## 9. PEP 479 in `search_wrapper`

**The original.** `search_wrapper` is a generator that calls `next()` by hand and
catches `StopIteration` as a control-flow signal. When the rate-limit retry
calls `next(gen_back)` on an exhausted backup, the `StopIteration` escapes the
generator body, and PEP 479 replaces it with
`RuntimeError('generator raised StopIteration')`, which reaches the user through
the search loop's `except Exception` branch.

**Why not directly.** JavaScript signals exhaustion with `{done: true}` and has
no PEP 479.

**What preserves the behaviour.** `StopIteration` is an exception type here, and
`PyGenerator.__next__` converts one raised inside the body into
`PyRuntimeError` with the same message, attaching the original as its cause.
Exercised by the behaviour harness's "backup exhausted" scenario.

## 10. Exception names

**The original.** An uncaught exception is reported by the interpreter as
`ClassName: str(exc)`.

**Why it needed care.** Four Python built-ins are spelled with a `Py` prefix here
so they cannot be confused with JavaScript's own globals. Reported literally,
they would print `PyError:` where the original prints `Exception:`.

**What preserves the behaviour.** Each such class carries a static `pyName`, and
the reported name is that when present and the class's own name otherwise — so
`SystemExit` and `ForbiddenError`, whose JavaScript names are already their
Python names, keep them. `str(exc)` follows `BaseException.__str__`: the empty
string for no argument, `str()` of the argument for one, the argument tuple's
repr for several.

## 11. The dorks file lookup

**The original.** When no dictionary is named, it looks in `.` and then in
`os.path.join(sys.prefix, 'github-dorks/')`, where `setup.py`'s `data_files`
installs it.

**Why not directly.** npm has no shared data directory. `package.json` ships
`github-dorks.txt` inside the package.

**What it became.** The same two-element search, with the package root standing
in for `sys.prefix`.

**What preserves the behaviour.** `.` is still tried first, so a dictionary in
the working directory wins exactly as before, and the second location still
resolves to where installation put the file.

## 12. Reading the dictionary

**The original.** Iterates the file object, which yields universal newlines: a
lone CR ends a line just as LF and CRLF do.

**What preserves the behaviour.** `readLines` splits on `\r\n`, `\r` or `\n` and
drops the empty trailing element, matching what iteration yields for a file that
does or does not end in a newline. Both a CRLF and a CR-only dictionary are
scenarios in the behaviour harness.

`str.strip()` is likewise not `String.trim()`: Python's whitespace set includes
`\x1c`–`\x1f` and `\x85` and excludes the byte-order mark, and JavaScript's is
the other way round on both counts. Since the filter reads the first character
of the stripped line, the two disagree on a dictionary whose first line carries a
BOM. `pyStrip` uses Python's set.

## 13. What the test suite's stubs became

**The original's suite** installs stub `github3` and `feedparser` modules into
`sys.modules` so the script can be imported without its runtime dependencies
present, and defines two stub exception classes for the search loop to
distinguish.

**Why it has no counterpart.** The port ships `github3.js` and `feedparser.js`,
so the modules the tool imports always exist and the exception hierarchy the
search loop distinguishes is the real one rather than a stand-in. Removing the
stubs makes the migrated suite test *more* than the original's did, not less:
its `GitHubError`/`ForbiddenError` cases now run against the ported hierarchy.

**What is not lost.** The suite still injects a scripted client in place of
`runtime.gh`, exactly as the original patches `gh`, so no case reaches the
network.

---

## Preserved flaws

Each of these is a defect in the original. Each is reproduced, and each has a
note at its site in the code saying so.

1. **`addendum` is read after the loop that assigns it.**
   `search` assigns `addendum` inside the per-dork loop and reads it in the
   final `if not found:` line. A dictionary containing no dork lines — empty, or
   comments only — reaches that read with the name unbound, and the original
   raises `UnboundLocalError`. The port raises `PyUnboundLocalError` with
   CPython's message rather than printing a message with `undefined` in it.
   Site: `src/github-dork.js`, `search`.

2. **The two sentences in `monit`'s banner are concatenated without a space.**
   The printed line reads `...to be dorked.Every new merged pull request...`.
   Preserved. Site: `src/github-dork.js`, `monit`.

3. **The two error branches print their lines in opposite orders.**
   The `GitHubError` branch prints its explanation and then the exception; the
   generic branch prints the exception and then its explanation. Preserved.
   Site: `src/github-dork.js`, `search`.

4. **`ForbiddenError` is a subclass of `GitHubError`, so a rate limit that does
   not clear is reported as a GitHub error.** When the retry's backup re-raises,
   the exception escapes `search_wrapper` and is caught by the `GitHubError`
   branch, aborting the remaining dorks. Preserved, and covered by a behaviour
   scenario.

5. **A rate-limit reset already in the past yields a negative sleep**, and
   `time.sleep` rejects it with `ValueError`. The port's `time.sleep` rejects it
   the same way rather than clamping to zero. Covered by a behaviour scenario.

6. **`search_wrapper`'s bare `except Exception as e: raise e`** re-raises with a
   truncated traceback. The port's equivalent branch rethrows, matching the
   control flow; JavaScript has no traceback to truncate.

## Necessary differences

Behaviours the port cannot reproduce identically, each with why it is not
observable through the tool's interface.

1. **No `int`/`float` distinction.** A JavaScript number cannot be both `42` and
   `42.0`. The port renders a number with Python's `int` rules when it holds an
   integral value, and exposes `pyFloat()` to force the float rendering where the
   distinction matters. Through the tool, `score` comes from the GitHub API as
   JSON, where the same ambiguity already exists, so the difference is not
   reachable from a real search — only from a hand-constructed result, which is
   why the differential harness tags its floats explicitly and covers both.

2. **`open(..., newline='')`.** The original passes it so that the CSV writer's
   CRLF reaches the file untranslated. Node performs no such translation, so
   nothing in the port corresponds to the argument. The bytes are identical,
   which the behaviour harness checks directly.

3. **Tracebacks.** An uncaught exception in the original prints a multi-line
   traceback; the port prints the final `Name: message` line. The CLI harness
   compares that line and the exit status, which is what a caller can act on.

4. **`copy.copy` of a `dict_keyiterator`, `set_iterator`, `zip`, `map` and the
   other Python iterator kinds.** `search_code` returns exactly one type, so no
   other kind reaches `copy()` through the tool. They were captured anyway, to
   establish that the one that does reach it behaves as the port assumes.

5. **`feedparser`'s full surface.** `monit` reads five keys from a parsed feed;
   `feedparser.js` implements those, the `FeedParserDict` alias table, and the
   Atom subset GitHub's private feed uses. Everything else feedparser does —
   RSS variants, sanitisation, date parsing, character-set detection — has no
   counterpart, because nothing in this tool reads it.

6. **`github3.py`'s full surface.** The tool calls `search_code` and
   `rate_limit` and distinguishes two exception classes. Those, the iterator's
   copy-visible shape, the status-to-class table and `GitHubError.__str__` are
   ported. The rest of the library is not.
