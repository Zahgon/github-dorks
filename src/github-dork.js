// The port of github-dork.py.
//
// One module, the same five functions in the same order, each doing what its
// Python counterpart does. Where a line here looks odd, the odd thing is in the
// original and is reproduced on purpose; those places carry a note.
//
// Two shapes had to change and both are recorded in MIGRATION.md:
//
//   * Python's keyword arguments become a single options object, so that every
//     call site still names what it passes, as all four of them do.
//   * every function that reaches the network is async, because Node has no
//     synchronous HTTP and github3's iterator pages as it is consumed.
//
// The module-level `gh` the original builds at import time lives on `runtime`
// rather than as a module binding, because the suite replaces it and an ES
// module's exported bindings cannot be replaced from outside.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import github, { exceptions } from './github3.js';
import feedparser from './feedparser.js';
import * as csv from './pycsv.js';
import { copy } from './pycopy.js';
import { generator, pyNext, pyIterate } from './pyiter.js';
import { PyError, PyUnboundLocalError, StopIteration } from './pyerrors.js';
import { pyStr, pyStrip } from './pystr.js';
import { print, sys } from './pysys.js';
import { time } from './pytime.js';
import { ArgumentParser, SystemExit } from './pyargparse.js';

export const __version__ = '0.1.1';

// setup.py installs github-dorks.txt into <sys.prefix>/github-dorks/, and the
// original looks there when no dictionary was named. npm has no such shared
// data directory: package.json ships the file inside the package, so the
// package root is where the same lookup has to land.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const runtime = {
  gh_user: process.env.GH_USER ?? null,
  gh_pass: process.env.GH_PWD ?? null,
  gh_token: process.env.GH_TOKEN ?? null,
  gh_url: process.env.GH_URL ?? null,
  gh: null,
};

runtime.gh = runtime.gh_url === null
  ? new github.GitHub({
    username: runtime.gh_user,
    password: runtime.gh_pass,
    token: runtime.gh_token,
  })
  : new github.GitHubEnterprise({
    url: runtime.gh_url,
    username: runtime.gh_user,
    password: runtime.gh_pass,
    token: runtime.gh_token,
  });

const isFile = (target) => {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
};

// Iterating a text-mode file yields universal newlines: a lone CR ends a line
// just as LF and CRLF do. Splitting on LF alone would read a CR-separated
// dictionary as one enormous dork.
const readLines = (filename) => {
  const lines = fs.readFileSync(filename, 'utf8').split(/\r\n|\r|\n/u);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

// open(filename, 'w'): the file is created and truncated here, before any row
// is written, so a run that finds no results still replaces whatever was there.
const openWriter = (filename) => {
  const fd = fs.openSync(filename, 'w');
  return {
    write(text) {
      fs.writeSync(fd, Buffer.from(text, 'utf8'));
    },
    close() {
      fs.closeSync(fd);
    },
  };
};

// `except Exception` -- everything except the BaseException subclasses, of
// which only SystemExit can occur in this program.
const isException = (exc) => !(exc instanceof SystemExit);

export const searchWrapper = generator(async function* searchWrapper(gen) {
  for (;;) {
    const genBack = copy(gen);
    let item;
    try {
      item = await pyNext(gen);
    } catch (exc) {
      if (exc instanceof StopIteration) return;
      if (exc instanceof exceptions.ForbiddenError) {
        const searchRateLimit = (await runtime.gh.rate_limit()).resources.search;
        const resetTime = searchRateLimit.reset;
        const currentTime = Math.trunc(time.time());
        const sleepTime = resetTime - currentTime + 1;
        sys.stderr.write(
          `GitHub Search API rate limit reached. Sleeping for ${sleepTime} seconds.\n\n`,
        );
        await time.sleep(sleepTime);
        // A StopIteration raised here escapes the generator body, and PEP 479
        // turns it into RuntimeError rather than ending the iteration. That is
        // what a retry finds when its backup shares the exhausted position.
        yield await pyNext(genBack);
        continue;
      }
      throw exc;
    }
    yield item;
  }
});

export async function metasearch({
  repo_to_search = null,
  user_to_search = null,
  gh_dorks_file = null,
  active_monit = null,
  output_filename = null,
  refresh_time = 60,
} = {}) {
  if (active_monit === null) {
    await search({ repo_to_search, user_to_search, gh_dorks_file, active_monit, output_filename });
  } else {
    await monit({ gh_dorks_file, active_monit, refresh_time });
  }
}

export async function monit({
  gh_dorks_file = null,
  active_monit = null,
  refresh_time = 60,
} = {}) {
  if (runtime.gh_user === null) {
    throw new PyError('Error, env Github user variable needed');
  }
  // The two sentences are concatenated with no space between them in the
  // original, so the printed line reads "...dorked.Every new...". Preserved.
  print(
    'Monitoring user private feed searching new code to be dorked.'
    + 'Every new merged pull request trigger user scan.',
  );
  print('-----');
  const itemsHistory = [];
  const ghPrivateFeed = `https://github.com/${runtime.gh_user}.private.atom?token=${active_monit}`;
  for (;;) {
    const feed = await feedparser.parse(ghPrivateFeed);
    for (const item of feed.items) {
      if (item.title.includes('merged pull')) {
        if (!itemsHistory.includes(item.title)) {
          await search({
            user_to_search: item.author_detail.name,
            gh_dorks_file,
          });
          itemsHistory.push(item.title);
        }
      }
    }
    print('Waiting for new items...');
    await time.sleep(refresh_time);
  }
}

export async function search({
  repo_to_search = null,
  user_to_search = null,
  gh_dorks_file = null,
  active_monit = null,
  output_filename = null,
} = {}) {
  if (gh_dorks_file === null) {
    for (const pathPrefix of ['.', path.join(PACKAGE_ROOT, 'github-dorks/')]) {
      const filename = path.join(pathPrefix, 'github-dorks.txt');
      if (isFile(filename)) {
        gh_dorks_file = filename;
        break;
      }
    }
  }

  if (gh_dorks_file === null || !isFile(gh_dorks_file)) {
    throw new PyError('Error, the dorks file path is not valid');
  }
  if (user_to_search) print('Scanning User: ', user_to_search);
  if (repo_to_search) print('Scanning Repo: ', repo_to_search);
  let found = false;

  const outputFile = output_filename ? openWriter(output_filename) : null;

  // Left unassigned on purpose: the original assigns `addendum` inside the
  // loop and reads it after, so a dictionary with no dork lines in it reaches
  // the read with the name still unbound. Preserved; see the throw below.
  let addendum;

  try {
    let csvWriter = null;
    if (outputFile) {
      csvWriter = csv.writer(outputFile);
      csvWriter.writerow([
        'Issue Type (Dork)', 'Text Matches', 'File Path',
        'Score/Relevance', 'URL of File',
      ]);
    }
    for (const line of readLines(gh_dorks_file)) {
      let dork = pyStrip(line);
      if (!dork || '#;'.includes(dork[0])) continue;
      addendum = '';
      if (repo_to_search) addendum = ' repo:' + repo_to_search;
      else if (user_to_search) addendum = ' user:' + user_to_search;

      dork = dork + addendum;
      const searchResults = searchWrapper(runtime.gh.search_code(dork));
      try {
        for await (const searchResult of pyIterate(searchResults)) {
          found = true;
          const fmtArgs = {
            dork,
            text_matches: searchResult.text_matches,
            path: searchResult.path,
            score: searchResult.score,
            url: searchResult.html_url,
          };

          if (csvWriter) {
            csvWriter.writerow([
              fmtArgs.dork, fmtArgs.text_matches,
              fmtArgs.path, fmtArgs.score, fmtArgs.url,
            ]);
          } else {
            const result = [
              `Found result for ${pyStr(fmtArgs.dork)}`,
              `Text matches: ${pyStr(fmtArgs.text_matches)}`,
              `File path: ${pyStr(fmtArgs.path)}`,
              `Score/Relevance: ${pyStr(fmtArgs.score)}`,
              `URL of File: ${pyStr(fmtArgs.url)}`,
              '',
            ].join('\n');
            print(result);
          }
        }
      } catch (exc) {
        if (exc instanceof exceptions.GitHubError) {
          print('GitHubError encountered on search of dork: ' + dork);
          print(exc);
          return;
        }
        if (!isException(exc)) throw exc;
        // The two branches print their two lines in opposite orders. Preserved.
        print(exc);
        print('Error encountered on search of dork: ' + dork);
      }
    }
  } finally {
    if (outputFile) outputFile.close();
  }

  if (!found) {
    if (addendum === undefined) {
      throw new PyUnboundLocalError(
        "cannot access local variable 'addendum' where it is not associated with a value",
      );
    }
    print('No results for your dork search' + addendum + '. Hurray!');
  }
}

const defaultProg = () => path.basename(process.argv[1] ?? 'github-dork.js');

export async function main({ argv = process.argv.slice(2), prog = defaultProg() } = {}) {
  const parser = new ArgumentParser({
    prog,
    description: 'Search github for github dorks',
    epilog: 'Use responsibly, Enjoy pentesting',
  });

  parser.addArgument(['-v', '--version'], {
    kind: 'version',
    version: '%(prog)s ' + __version__,
  });

  const group = parser.addMutuallyExclusiveGroup({ required: true });
  group.addArgument(['-u', '--user'], {
    dest: 'user_to_search',
    help: 'Github user/org to search within. Eg: techgaun',
  });

  group.addArgument(['-r', '--repo'], {
    dest: 'repo_to_search',
    help: 'Github repo to search within. Eg: techgaun/github-dorks',
  });

  parser.addArgument(['-d', '--dork'], {
    dest: 'gh_dorks_file',
    help: 'Github dorks file. Eg: github-dorks.txt',
  });

  group.addArgument(['-m', '--monit'], {
    dest: 'active_monit',
    help: 'Monitors Github user private feed with feed token',
  });

  parser.addArgument(['-o', '--outputFile'], {
    dest: 'output_filename',
    help: 'CSV File to write results to. This overwrites the file provided! Eg: out.csv',
  });

  const args = parser.parseArgs(argv);
  await metasearch({
    repo_to_search: args.repo_to_search,
    user_to_search: args.user_to_search,
    gh_dorks_file: args.gh_dorks_file,
    active_monit: args.active_monit,
    output_filename: args.output_filename,
  });
}
