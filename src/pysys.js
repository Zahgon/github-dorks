// Stands in for the parts of sys and of the print builtin that the source
// uses: sys.stderr.write in search_wrapper, and print in five places.
//
// It is an object rather than a set of functions because the source's own
// suite redirects stdout to capture what search() prints, and
// contextlib.redirect_stdout works by replacing the sys.stdout attribute. An
// ES module's exported bindings cannot be replaced from outside, so the two
// streams live on an object whose properties can be.

import { pyStr } from './pystr.js';

const display = (value) => {
  if (value !== null && value !== undefined && typeof value.__str__ === 'function') {
    return value.__str__();
  }
  if (value instanceof Error) return value.message;
  return pyStr(value);
};

export const sys = {
  stdout: { write: (text) => { process.stdout.write(text); } },
  stderr: { write: (text) => { process.stderr.write(text); } },
};

export function print(...args) {
  sys.stdout.write(`${args.map(display).join(' ')}\n`);
}
