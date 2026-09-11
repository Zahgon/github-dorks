// Stands in for copy.copy(), for the single call site the source has:
// `gen_back = copy(gen)` at the top of search_wrapper's loop.
//
// That one line decides what the retry does, and what it does depends on the
// runtime type of what gh.search_code() returned -- three different answers,
// all of them reachable:
//
//   * github3's SearchIterator is a plain object whose iteration state lives in
//     an attribute created lazily by its first __next__. Shallow-copying it
//     before that attribute exists yields a backup that restarts; copying it
//     after yields one that shares the position and advances.
//   * the list_iterator the source's own suite injects copies to an
//     independent position.
//   * a hand-written generator cannot be copied at all.
//
// Observed by executing CPython 3.11 against github3 4.0.1; see
// ../../github-dorks-parity-harness/probe_wrapper.py sections A-E.

import { PyTypeError } from './pyerrors.js';

// Python dispatches copy.copy() to a __copy__ method when the class defines
// one. A well-known symbol stands in for that dunder so the two iterator kinds
// can each answer for themselves.
export const COPY = Symbol('python-copy');

export function copy(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object' && typeof value !== 'function') return value;
  if (typeof value[COPY] === 'function') return value[COPY]();
  if (Array.isArray(value)) return value.slice();
  if (value instanceof Map) return new Map(value);
  if (value instanceof Set) return new Set(value);

  // copy._copy_inst: a new instance of the same class whose __dict__ is a
  // shallow copy of the original's. Own enumerable properties are this port's
  // __dict__, so an attribute the original has not created yet is absent from
  // the copy -- which is the whole of the SearchIterator distinction above.
  const duplicate = Object.create(Object.getPrototypeOf(value));
  Object.assign(duplicate, value);
  return duplicate;
}

export function uncopyable(kind) {
  return new PyTypeError(`cannot pickle '${kind}' object`);
}
