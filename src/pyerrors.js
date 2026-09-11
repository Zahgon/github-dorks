// The exception types the port raises and catches, carrying Python's str().
//
// github-dork.py's control flow is built out of exceptions: search_wrapper()
// tells StopIteration from ForbiddenError from everything else, search() tells
// GitHubError from everything else and prints str(e) for both, and search()
// and monit() each raise a bare Exception whose message the source's own suite
// matches on. JavaScript's Error has a message but no equivalent of str(exc),
// which is '' for an exception raised with no argument, the argument itself
// for one, and the argument tuple's repr for several -- and which several of
// these subclasses override. So the distinction is re-created here rather than
// borrowed from Error.
//
// The messages below are the ones CPython 3.11 produces, captured by
// execution; see ../../github-dorks-parity-harness/probe_wrapper.py sections D
// and F and probe_primitives.py section G.

import { pyRepr, pyStr } from './pystr.js';

// The name an unhandled exception is reported under. It is the Python class's
// name, which is not always this class's: the four built-ins below are spelled
// with a Py prefix here to keep them clear of JavaScript's own globals, and a
// traceback naming them that way would not match the original's. Checked as an
// own property rather than an inherited one, so that a subclass whose JS name
// is already its Python name -- SystemExit, ForbiddenError -- keeps it.
const pythonName = (cls) => (Object.hasOwn(cls, 'pyName') ? cls.pyName : cls.name);

export class PyException extends Error {
  constructor(...args) {
    super(args.length === 1 ? String(args[0]) : '');
    this.name = pythonName(new.target);
    // BaseException.args, which is what str() and repr() are computed from.
    this.args = args;
  }

  // str(exc). BaseException renders no argument as the empty string, one
  // argument as str() of it, and several as the repr of the argument tuple.
  __str__() {
    if (this.args.length === 0) return '';
    if (this.args.length === 1) return pyStr(this.args[0]);
    return '(' + this.args.map(pyRepr).join(', ') + ')';
  }

  // repr(exc)
  __repr__() {
    return `${this.name}(${this.args.map(pyRepr).join(', ')})`;
  }
}

// The bare `raise Exception('...')` the source uses twice. Named PyError rather
// than Exception so that it cannot be confused with JavaScript's own global.
export class PyError extends PyException {
  static pyName = 'Exception';
}

// Raised by next() on an exhausted iterator. str() of one raised with no
// argument is the empty string, which is why the probe reports it with nothing
// after the colon.
export class StopIteration extends PyException {}

export class PyTypeError extends PyException {
  static pyName = 'TypeError';
}

export class PyValueError extends PyException {
  static pyName = 'ValueError';
}

export class PyRuntimeError extends PyException {
  static pyName = 'RuntimeError';
}

// Reading a function-local name before anything has been assigned to it. The
// source reaches this on a dorks file that contains no dork lines: `addendum`
// is assigned inside the loop body and read after the loop. See the note at
// its use site in github-dork.js -- the behaviour is preserved on purpose.
export class PyUnboundLocalError extends PyException {
  static pyName = 'UnboundLocalError';
}

// str(x) for an exception, matching how print(e) renders one.
export function excStr(exc) {
  if (exc && typeof exc.__str__ === 'function') return exc.__str__();
  if (exc instanceof Error) return exc.message;
  return String(exc);
}
