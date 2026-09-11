// Python's iterator protocol, as search_wrapper() uses it.
//
// The source drives its iterator by hand -- `next(gen)` inside a try, with
// StopIteration as a caught control-flow signal rather than an error -- and it
// is itself a generator, so PEP 479 applies to it: a StopIteration that
// escapes a generator body is replaced by RuntimeError('generator raised
// StopIteration'). That replacement is not incidental. It is what the source
// does when the rate-limit retry finds its backup exhausted, and it reaches
// the user as a printed line, so the port has to raise the same thing.
//
// JavaScript signals exhaustion with a {done: true} record and has no PEP 479,
// so both halves are re-created here. Observed by executing CPython 3.11; see
// ../../github-dorks-parity-harness/probe_wrapper.py sections D and F.
//
// __next__ may return a value or a promise of one, because github3's iterator
// pages over the network and Node has no synchronous HTTP. Every caller awaits
// it; awaiting a plain value is a no-op, so the synchronous iterators the
// suite injects keep working unchanged. See MIGRATION.md.

import { StopIteration, PyRuntimeError, PyTypeError } from './pyerrors.js';
import { COPY, uncopyable } from './pycopy.js';

const isThenable = (value) =>
  value !== null && typeof value === 'object' && typeof value.then === 'function';

export function pyNext(iterator) {
  return iterator.__next__();
}

// iter([...]) -- what the source's suite hands to search_wrapper in place of a
// real search. copy.copy() of one snapshots the position: the backup replays
// from wherever the original had reached, independently of it.
export class PyListIterator {
  constructor(items, index = 0) {
    this.items = items;
    this.index = index;
  }

  __next__() {
    if (this.index >= this.items.length) throw new StopIteration();
    const value = this.items[this.index];
    this.index += 1;
    return value;
  }

  [COPY]() {
    return new PyListIterator(this.items, this.index);
  }

  [Symbol.asyncIterator]() {
    return pyIterate(this);
  }
}

export function iter(value) {
  if (value === null || value === undefined) {
    throw new PyTypeError("'NoneType' object is not iterable");
  }
  if (typeof value.__next__ === 'function') return value;
  if (Array.isArray(value)) return new PyListIterator(value);
  if (typeof value[Symbol.iterator] === 'function') {
    return new PyListIterator([...value]);
  }
  throw new PyTypeError(`'${typeof value}' object is not iterable`);
}

// PEP 479: StopIteration escaping a generator body becomes RuntimeError, with
// the original attached as its cause.
function pep479(exc) {
  if (!(exc instanceof StopIteration)) return exc;
  const runtimeError = new PyRuntimeError('generator raised StopIteration');
  runtimeError.cause = exc;
  return runtimeError;
}

// A Python generator. Two properties the source depends on and a JS generator
// does not have: copy.copy() refuses it, and a StopIteration raised inside the
// body surfaces as RuntimeError rather than ending the iteration silently.
export class PyGenerator {
  constructor(factory) {
    this.factory = factory;
    this.inner = null;
  }

  __next__() {
    if (this.inner === null) this.inner = this.factory();
    let step;
    try {
      step = this.inner.next();
    } catch (exc) {
      throw pep479(exc);
    }
    if (isThenable(step)) {
      return step.then(
        (settled) => {
          if (settled.done) throw new StopIteration();
          return settled.value;
        },
        (exc) => {
          throw pep479(exc);
        },
      );
    }
    if (step.done) throw new StopIteration();
    return step.value;
  }

  [COPY]() {
    throw uncopyable('generator');
  }

  [Symbol.asyncIterator]() {
    return pyIterate(this);
  }
}

export function generator(factory) {
  return (...args) => new PyGenerator(() => factory(...args));
}

// `for x in iterator` -- run the iterator to exhaustion, treating StopIteration
// as the end rather than letting it escape.
export async function* pyIterate(iterator) {
  for (;;) {
    let value;
    try {
      value = await iterator.__next__();
    } catch (exc) {
      if (exc instanceof StopIteration) return;
      throw exc;
    }
    yield value;
  }
}
