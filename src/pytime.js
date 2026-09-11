// Stands in for the two functions the source imports from time.
//
// An object rather than two exported functions, so that a test can replace
// time.sleep the way unittest.mock.patch.object replaces it on the module --
// without which exercising the rate-limit retry means waiting out a real
// sleep.
//
// sleep() rejecting a negative duration is not defensive coding: the source
// computes its argument as reset - now + 1, which is negative whenever the
// rate limit's reset time has already passed, and CPython raises rather than
// returning. Captured in probe_primitives.py section G.

import { PyValueError } from './pyerrors.js';

export const time = {
  time: () => Date.now() / 1000,
  sleep: (seconds) => {
    if (seconds < 0) throw new PyValueError('sleep length must be non-negative');
    return new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
  },
};
