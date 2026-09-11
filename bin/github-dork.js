#!/usr/bin/env node

// The `if __name__ == '__main__': main()` tail of github-dork.py, plus what
// the interpreter does around it.
//
// Python turns an uncaught exception into a traceback on stderr and exit
// status 1, and a SystemExit into that exit status with nothing printed. Node
// does neither by default -- an unhandled rejection prints its own format and
// exits 1, and nothing maps SystemExit to a status. Both are re-created here so
// that the six argparse exits and the two raised errors reach a shell the way
// the original's do; see the exit statuses in
// ../../github-dorks-parity-harness/probe_argparse.py.

import { main } from '../src/github-dork.js';
import { SystemExit } from '../src/pyargparse.js';
import { excStr } from '../src/pyerrors.js';

try {
  await main();
} catch (exc) {
  if (exc instanceof SystemExit) {
    process.exitCode = typeof exc.code === 'number' ? exc.code : 0;
  } else {
    const name = exc?.name ?? 'Exception';
    const message = excStr(exc);
    process.stderr.write(`${name}: ${message}\n`);
    process.exitCode = 1;
  }
}
