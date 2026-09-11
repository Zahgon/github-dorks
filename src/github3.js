// Stands in for github3.py, restricted to the surface github-dork.py touches:
// GitHub / GitHubEnterprise construction, search_code(), rate_limit(), and the
// two exception classes the search loop distinguishes.
//
// There is no github3 on npm, and the parts the source depends on are not
// incidental: the iterator search_code() returns is copy.copy()'d by
// search_wrapper on every turn of its loop, and what that copy does depends on
// the iterator's internal shape. So the shape is reproduced -- iteration state
// held in an attribute created lazily by the first __next__, and nothing on the
// class that intercepts the copy -- rather than replaced by a JS async
// generator, which would copy differently or not at all.
//
// Class names, exception hierarchy, the status-to-class table and
// GitHubError's str() are github3 4.0.1's own, read from the installed package
// and confirmed by execution; see
// ../../github-dorks-parity-harness/probe_wrapper.py.

import { PyException, StopIteration } from './pyerrors.js';
import { pyStr } from './pystr.js';

export class GitHubException extends PyException {}

export class GitHubError extends GitHubException {
  constructor(response) {
    super(response);
    this.response = response;
    this.code = response?.status_code ?? null;
    this.errors = [];
    const body = response?.json;
    if (body && typeof body === 'object') {
      this.msg = body.message;
      if (body.errors) this.errors = body.errors;
    } else {
      this.msg = response?.content || '[No message]';
    }
  }

  get message() {
    return this.msg;
  }

  __str__() {
    return `${pyStr(this.code)} ${pyStr(this.msg)}`;
  }

  __repr__() {
    return `<${this.name} [${this.msg || this.code}]>`;
  }
}

export class ResponseError extends GitHubError {}
export class BadRequest extends ResponseError {}
export class AuthenticationFailed extends ResponseError {}
export class ForbiddenError extends ResponseError {}
export class NotFoundError extends ResponseError {}
export class MethodNotAllowed extends ResponseError {}
export class NotAcceptable extends ResponseError {}
export class Conflict extends ResponseError {}
export class UnprocessableEntity extends ResponseError {}
export class UnavailableForLegalReasons extends ResponseError {}
export class ClientError extends ResponseError {}
export class ServerError extends ResponseError {}
export class TransportError extends GitHubException {}
export class ConnectionError extends TransportError {}

const ERROR_CLASSES = {
  400: BadRequest,
  401: AuthenticationFailed,
  403: ForbiddenError,
  404: NotFoundError,
  405: MethodNotAllowed,
  406: NotAcceptable,
  409: Conflict,
  422: UnprocessableEntity,
  451: UnavailableForLegalReasons,
};

export function errorFor(response) {
  let klass = ERROR_CLASSES[response.status_code];
  if (klass === undefined) {
    if (response.status_code >= 400 && response.status_code < 500) klass = ClientError;
    if (response.status_code >= 500 && response.status_code < 600) klass = ServerError;
  }
  return new klass(response);
}

export const exceptions = {
  GitHubException,
  GitHubError,
  ResponseError,
  BadRequest,
  AuthenticationFailed,
  ForbiddenError,
  NotFoundError,
  MethodNotAllowed,
  NotAcceptable,
  Conflict,
  UnprocessableEntity,
  UnavailableForLegalReasons,
  ClientError,
  ServerError,
  TransportError,
  ConnectionError,
  error_for: errorFor,
};

export class CodeSearchResult {
  constructor(data) {
    this.git_url = data.git_url;
    this.html_url = data.html_url;
    this.name = data.name;
    this.path = data.path;
    this.repository = data.repository;
    this.score = data.score;
    this.sha = data.sha;
    this.text_matches = data.text_matches ?? [];
  }

  __repr__() {
    return `<CodeSearchResult [${this.path}]>`;
  }
}

// The link header parsing github3 gets from requests' response.links.
function relNext(linkHeader) {
  if (!linkHeader) return '';
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]*)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(part.trim());
    if (match && match[2].trim() === 'next') return match[1];
  }
  return '';
}

export class GitHubSession {
  constructor() {
    this.headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'github-dorks',
    };
    this.auth = null;
  }

  login({ username, password, token } = {}) {
    if (token) {
      this.auth = { kind: 'token', token };
      this.headers.Authorization = `token ${token}`;
    } else if (username && password) {
      this.auth = { kind: 'basic', username, password };
      const basic = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      this.headers.Authorization = `Basic ${basic}`;
    }
  }

  async get(url, { params, headers } = {}) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== null && value !== undefined) target.searchParams.set(key, String(value));
    }
    const response = await fetch(target, { headers: { ...this.headers, ...headers } });
    const content = await response.text();
    let body = null;
    try {
      body = JSON.parse(content);
    } catch {
      body = null;
    }
    return {
      status_code: response.status,
      headers: Object.fromEntries(response.headers),
      links: { next: { url: relNext(response.headers.get('link')) } },
      content,
      json: body,
    };
  }
}

// GitHubIterator, with the property search_wrapper is built around: iteration
// state lives in `__i__`, which does not exist until the first __next__ call.
// copy.copy() of one taken before that call yields a backup that restarts from
// the beginning; one taken after shares the generator and advances it.
export class GitHubIterator {
  constructor(count, url, cls, session, params, etag, headers) {
    this.count = count;
    this.original = count;
    this.url = url;
    this.last_url = url;
    this.cls = cls;
    this.session = session;
    this.params = { ...(params ?? {}) };
    this.headers = { ...(headers ?? {}) };
    this.etag = etag ?? null;
    this.last_response = null;
    this.last_status = 0;
    this.list_key = null;
    this.path = new URL(url).pathname;
  }

  async *__iter__() {
    this.last_url = this.url;
    let params = this.params;
    const headers = this.headers;

    if (this.count > 0 && this.count <= 100 && this.count !== -1) {
      params.per_page = this.count;
    }
    if (!('per_page' in params) && this.count === -1) {
      params.per_page = 100;
    }

    while ((this.count === -1 || this.count > 0) && this.last_url) {
      const response = await this.session.get(this.last_url, { params, headers });
      this.last_response = response;
      this.last_status = response.status_code;
      if (params) params = null;

      if (response.status_code !== 200) throw errorFor(response);
      if (!this.etag && response.headers.etag) this.etag = response.headers.etag;

      const json = this.getJson(response);
      if (json === null || json === undefined) break;

      for (const item of json) {
        if (item === null) continue;
        yield new this.cls(item);
        if (this.count > 0) this.count -= 1;
        if (this.count === 0) break;
      }

      this.last_url = response.links.next.url ?? '';
    }
  }

  getJson(response) {
    return response.json;
  }

  __next__() {
    if (!('__i__' in this)) this.__i__ = this.__iter__();
    return this.__i__.next().then((step) => {
      if (step.done) throw new StopIteration();
      return step.value;
    });
  }

  next() {
    return this.__next__();
  }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      async next() {
        try {
          return { value: await self.__next__(), done: false };
        } catch (exc) {
          if (exc instanceof StopIteration) return { value: undefined, done: true };
          throw exc;
        }
      },
    };
  }
}

export class SearchIterator extends GitHubIterator {
  constructor(count, url, cls, session, params, etag, headers) {
    super(count, url, cls, session, params, etag, headers);
    this.total_count = 0;
    this.items = [];
  }

  getJson(response) {
    const json = response.json ?? {};
    this.total_count = json.total_count ?? this.total_count;
    this.items = json.items ?? [];
    return json.items;
  }
}

export class GitHub {
  constructor({ username = '', password = '', token = '', session = null } = {}) {
    this.session = session ?? new GitHubSession();
    this.apiUrl = 'https://api.github.com';
    if (token) this.session.login({ username, token });
    else if (username && password) this.session.login({ username, password });
  }

  buildUrl(...parts) {
    return [this.apiUrl.replace(/\/+$/, ''), ...parts].join('/');
  }

  search_code(query, { sort = null, order = null, text_match = false, number = -1, etag = null } = {}) {
    const params = { q: query };
    let headers = {};

    if (sort === 'indexed') params.sort = sort;
    if (sort && (order === 'asc' || order === 'desc')) params.order = order;
    if (text_match) {
      headers = { Accept: 'application/vnd.github.v3.full.text-match+json' };
    }

    return new SearchIterator(
      number,
      this.buildUrl('search', 'code'),
      CodeSearchResult,
      this.session,
      params,
      etag,
      headers,
    );
  }

  async rate_limit() {
    const response = await this.session.get(this.buildUrl('rate_limit'));
    if (response.status_code !== 200) throw errorFor(response);
    return response.json;
  }
}

export class GitHubEnterprise extends GitHub {
  constructor({ url, username = '', password = '', token = '', session = null } = {}) {
    super({ username, password, token, session });
    this.apiUrl = `${String(url).replace(/\/+$/, '')}/api/v3`;
  }
}

export default { GitHub, GitHubEnterprise, exceptions };
