// The port of tests/test_github_dork.py.
//
// Every test function of the original, under the same name, in the same order,
// with the same inputs and the same assertions. The original is quoted above
// each one so the correspondence can be checked by reading rather than trusted.
//
// The original's first thirty lines install stub `github3` and `feedparser`
// modules so that the source can be imported without its runtime dependencies
// present. That block has no counterpart here: the port ships its own
// github3.js and feedparser.js, so the modules the source imports always exist.
// The two stub exception classes went with it, and what they stood in for --
// the exception hierarchy the search loop distinguishes -- is the real one. See
// MIGRATION.md.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runtime, search } from '../src/github-dork.js';
import { reader } from '../src/pycsv.js';
import { PyListIterator } from '../src/pyiter.js';
import { pySplitlines, pyStrip } from '../src/pystr.js';
import { sys } from '../src/pysys.js';

// class SearchResult:
//     text_matches = ['secret, with comma']
//     path = 'config/file.env'
//     score = 42
//     html_url = 'https://github.example/result'
class SearchResult {
  text_matches = ['secret, with comma'];

  path = 'config/file.env';

  score = 42;

  html_url = 'https://github.example/result';
}

// class GitHubClient:
//     def search_code(self, query):
//         self.query = query
//         return iter([SearchResult()])
class GitHubClient {
  search_code(query) {
    this.query = query;
    return new PyListIterator([new SearchResult()]);
  }
}

// unittest.mock.patch.object(github_dork, 'gh', client), as a scope.
async function withGh(client, body) {
  const original = runtime.gh;
  runtime.gh = client;
  try {
    return await body();
  } finally {
    runtime.gh = original;
  }
}

// contextlib.redirect_stdout(io.StringIO()), returning what was captured.
async function redirectStdout(body) {
  const original = sys.stdout;
  let captured = '';
  sys.stdout = { write: (text) => { captured += text; } };
  try {
    await body();
  } finally {
    sys.stdout = original;
  }
  return captured;
}

// tempfile.TemporaryDirectory(), as a scope.
async function withTemporaryDirectory(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'github-dorks-'));
  try {
    return await body(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('SearchTests', () => {
  //     def test_writes_valid_csv_and_scopes_query_to_repository(self):
  //         client = GitHubClient()
  //         with tempfile.TemporaryDirectory() as directory:
  //             dorks = Path(directory) / 'dorks.txt'
  //             output = Path(directory) / 'results.csv'
  //             dorks.write_text('# comment\nfilename:.env PASSWORD\n', encoding='utf-8')
  //
  //             with patch.object(github_dork, 'gh', client):
  //                 github_dork.search(
  //                     repo_to_search='owner/repo',
  //                     gh_dorks_file=str(dorks),
  //                     output_filename=str(output),
  //                 )
  //
  //             with output.open(newline='', encoding='utf-8') as output_file:
  //                 rows = list(csv.reader(output_file))
  //
  //         self.assertEqual(client.query, 'filename:.env PASSWORD repo:owner/repo')
  //         self.assertEqual(len(rows), 2)
  //         self.assertEqual(rows[1][0], client.query)
  //         self.assertEqual(rows[1][1], "['secret, with comma']")
  test('test_writes_valid_csv_and_scopes_query_to_repository', async () => {
    const client = new GitHubClient();
    const rows = await withTemporaryDirectory(async (directory) => {
      const dorks = path.join(directory, 'dorks.txt');
      const output = path.join(directory, 'results.csv');
      fs.writeFileSync(dorks, '# comment\nfilename:.env PASSWORD\n', 'utf8');

      await withGh(client, () => search({
        repo_to_search: 'owner/repo',
        gh_dorks_file: dorks,
        output_filename: output,
      }));

      return [...reader(fs.readFileSync(output, 'utf8'))];
    });

    assert.equal(client.query, 'filename:.env PASSWORD repo:owner/repo');
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], client.query);
    assert.equal(rows[1][1], "['secret, with comma']");
  });

  //     def test_reports_when_no_results_are_found(self):
  //         client = GitHubClient()
  //         client.search_code = lambda query: iter([])
  //         with tempfile.TemporaryDirectory() as directory:
  //             dorks = Path(directory) / 'dorks.txt'
  //             dorks.write_text('filename:.env\n', encoding='utf-8')
  //             stdout = io.StringIO()
  //             with patch.object(github_dork, 'gh', client), redirect_stdout(stdout):
  //                 github_dork.search(
  //                     user_to_search='example', gh_dorks_file=str(dorks)
  //                 )
  //
  //         self.assertIn('No results for your dork search user:example', stdout.getvalue())
  test('test_reports_when_no_results_are_found', async () => {
    const client = new GitHubClient();
    client.search_code = () => new PyListIterator([]);
    const stdout = await withTemporaryDirectory(async (directory) => {
      const dorks = path.join(directory, 'dorks.txt');
      fs.writeFileSync(dorks, 'filename:.env\n', 'utf8');
      return redirectStdout(() => withGh(client, () => search({
        user_to_search: 'example', gh_dorks_file: dorks,
      })));
    });

    assert.ok(stdout.includes('No results for your dork search user:example'), stdout);
  });

  //     def test_rejects_missing_dorks_file_with_clear_error(self):
  //         with self.assertRaisesRegex(Exception, 'dorks file path is not valid'):
  //             github_dork.search(gh_dorks_file='/does/not/exist')
  test('test_rejects_missing_dorks_file_with_clear_error', async () => {
    await assert.rejects(
      () => search({ gh_dorks_file: '/does/not/exist' }),
      /dorks file path is not valid/,
    );
  });
});

//     @classmethod
//     def setUpClass(cls):
//         dictionary = Path(__file__).parents[1] / 'github-dorks.txt'
//         cls.lines = dictionary.read_text(encoding='utf-8').splitlines()
//         cls.dorks = [
//             line for line in cls.lines
//             if line and not line.startswith(('#', ';'))
//         ]
const dictionary = fileURLToPath(new URL('../github-dorks.txt', import.meta.url));
const lines = pySplitlines(fs.readFileSync(dictionary, 'utf8'));
const dorks = lines.filter(
  (line) => line && !(line.startsWith('#') || line.startsWith(';')),
);

// sorted() orders strings by code point; JavaScript's default sort orders them
// by UTF-16 code unit, which disagrees above the basic plane. Only observable
// when the assertion below fails, and a failure report that lists dorks in a
// different order than the original's is a difference in what the case reports.
const byCodePoint = (left, right) => {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

describe('DorkDictionaryTests', () => {
  //     def test_has_no_duplicate_dorks(self):
  //         duplicates = sorted({dork for dork in self.dorks if self.dorks.count(dork) > 1})
  //         self.assertEqual(duplicates, [])
  test('test_has_no_duplicate_dorks', () => {
    const counts = new Map();
    for (const dork of dorks) counts.set(dork, (counts.get(dork) ?? 0) + 1);
    const duplicates = [...new Set(dorks.filter((dork) => counts.get(dork) > 1))]
      .sort(byCodePoint);
    assert.deepEqual(duplicates, []);
  });

  //     def test_has_no_surrounding_whitespace(self):
  //         untrimmed = [line for line in self.lines if line != line.strip()]
  //         self.assertEqual(untrimmed, [])
  test('test_has_no_surrounding_whitespace', () => {
    const untrimmed = lines.filter((line) => line !== pyStrip(line));
    assert.deepEqual(untrimmed, []);
  });

  //     def test_has_balanced_quotes(self):
  //         malformed = [dork for dork in self.dorks if dork.count('"') % 2]
  //         self.assertEqual(malformed, [])
  test('test_has_balanced_quotes', () => {
    const malformed = dorks.filter(
      (dork) => [...dork].filter((ch) => ch === '"').length % 2,
    );
    assert.deepEqual(malformed, []);
  });

  //     def test_contains_modern_credential_families(self):
  //         dictionary = '\n'.join(self.dorks)
  //         for marker in (
  //             'github_pat_', 'glpat-', 'pypi-', 'OPENAI_API_KEY',
  //             'ANTHROPIC_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_API_TOKEN',
  //             'SUPABASE_SERVICE_ROLE_KEY', 'sk_live_',
  //         ):
  //             with self.subTest(marker=marker):
  //                 self.assertIn(marker, dictionary)
  test('test_contains_modern_credential_families', async (t) => {
    const joined = dorks.join('\n');
    for (const marker of [
      'github_pat_', 'glpat-', 'pypi-', 'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_API_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY', 'sk_live_',
    ]) {
      // subTest: each marker reports as its own case, so a failure names it.
      await t.test(`marker=${marker}`, () => {
        assert.ok(joined.includes(marker), `${marker} not found in dictionary`);
      });
    }
  });
});
