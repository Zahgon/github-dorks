// Stands in for feedparser, restricted to what monit() reads from it:
// feedparser.parse(url), then feed['items'], then each item's ['title'] and
// ['author_detail']['name'].
//
// feedparser returns a FeedParserDict, a dict subclass with a key alias table.
// 'items' is an alias for 'entries' and 'url' for 'href', so the key monit()
// asks for is not a key the parser ever stores. A port that returned a plain
// object with an `entries` property would make monit() read undefined, so the
// alias table is reproduced rather than resolved away.
//
// The alias entries below are feedparser 6.0.14's own keymap, read from the
// installed package; see the probe transcript in MIGRATION.md.

import { XMLParser } from './xmlmini.js';

const KEYMAP = {
  channel: 'feed',
  items: 'entries',
  guid: 'id',
  date: 'updated',
  date_parsed: 'updated_parsed',
  description: ['summary', 'subtitle'],
  description_detail: ['summary_detail', 'subtitle_detail'],
  url: ['href'],
  modified: 'updated',
  modified_parsed: 'updated_parsed',
  issued: 'published',
  issued_parsed: 'published_parsed',
  copyright: 'rights',
  copyright_detail: 'rights_detail',
  tagline: 'subtitle',
  tagline_detail: 'subtitle_detail',
};

// FeedParserDict.__getitem__: resolve through the alias table, then fall back
// to the literal key. A list alias resolves to the first member present.
export function feedGet(container, key) {
  if (container instanceof Map) {
    const realKey = KEYMAP[key] ?? key;
    if (Array.isArray(realKey)) {
      for (const candidate of realKey) {
        if (container.has(candidate)) return container.get(candidate);
      }
    } else if (container.has(realKey)) {
      return container.get(realKey);
    }
    return container.get(key);
  }
  const realKey = KEYMAP[key] ?? key;
  if (Array.isArray(realKey)) {
    for (const candidate of realKey) {
      if (candidate in container) return container[candidate];
    }
  } else if (realKey in container) {
    return container[realKey];
  }
  return container[key];
}

// A FeedParserDict: an object whose properties are the stored keys, read
// through feedGet so the aliases apply.
export function feedParserDict(entries) {
  return new Proxy(entries, {
    get(target, property) {
      if (typeof property !== 'string') return Reflect.get(target, property);
      if (property in target) return target[property];
      const aliased = KEYMAP[property];
      if (aliased === undefined) return undefined;
      const candidates = Array.isArray(aliased) ? aliased : [aliased];
      for (const candidate of candidates) {
        if (candidate in target) return target[candidate];
      }
      return undefined;
    },
    has(target, property) {
      if (typeof property !== 'string') return Reflect.has(target, property);
      if (property in target) return true;
      const aliased = KEYMAP[property];
      if (aliased === undefined) return false;
      const candidates = Array.isArray(aliased) ? aliased : [aliased];
      return candidates.some((candidate) => candidate in target);
    },
  });
}

function detail(node) {
  if (!node) return feedParserDict({ name: undefined, href: undefined, email: undefined });
  return feedParserDict({
    name: node.child('name')?.text,
    href: node.child('uri')?.text,
    email: node.child('email')?.text,
  });
}

function entryOf(node) {
  const author = node.child('author');
  return feedParserDict({
    title: node.child('title')?.text,
    id: node.child('id')?.text,
    link: node.child('link')?.attributes.href,
    published: node.child('published')?.text,
    updated: node.child('updated')?.text,
    summary: node.child('summary')?.text,
    author: author?.child('name')?.text,
    author_detail: detail(author),
  });
}

// feedparser.parse(). The source passes a URL string, which feedparser fetches
// itself; a string that is not a URL is parsed as a document. The `bozo` flag
// carries the parse failure rather than raising, which is why monit() has no
// error handling around this call.
export async function parse(urlOrDocument) {
  const result = {
    bozo: false,
    bozo_exception: undefined,
    entries: [],
    feed: feedParserDict({}),
    headers: {},
  };

  let document = urlOrDocument;
  if (/^https?:\/\//i.test(urlOrDocument)) {
    try {
      const response = await fetch(urlOrDocument, {
        headers: { Accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      result.status = response.status;
      result.headers = Object.fromEntries(response.headers);
      document = await response.text();
    } catch (exc) {
      result.bozo = true;
      result.bozo_exception = exc;
      return feedParserDict(result);
    }
  }

  let root;
  try {
    root = new XMLParser(document).parse();
  } catch (exc) {
    result.bozo = true;
    result.bozo_exception = exc;
    return feedParserDict(result);
  }

  result.entries = root.children('entry').concat(root.children('item')).map(entryOf);
  result.feed = feedParserDict({
    title: root.child('title')?.text,
    link: root.child('link')?.attributes.href,
    updated: root.child('updated')?.text,
  });
  return feedParserDict(result);
}

export default { parse };
