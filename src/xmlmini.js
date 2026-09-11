// A minimal XML reader, sufficient for the Atom documents feedparser.js is
// handed.
//
// Python ships an XML parser in its standard library and feedparser builds on
// it; Node ships none, and the alternative to writing one is a dependency the
// source does not have. What monit() reads out of a feed is four element texts
// and one nested one, so what is needed is element structure, attributes,
// character data and entity decoding -- not validation, not namespaces beyond
// ignoring prefixes, not DTDs.
//
// Namespace prefixes are dropped rather than resolved because feedparser
// matches Atom elements on their local names, and GitHub's private feed puts
// its extension elements in prefixed namespaces that monit() never reads.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[body];
    return named === undefined ? match : named;
  });
}

const localName = (name) => {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
};

export class XMLNode {
  constructor(name, attributes) {
    this.name = name;
    this.attributes = attributes;
    this.childNodes = [];
    this.chunks = [];
  }

  get text() {
    return this.chunks.join('');
  }

  child(name) {
    return this.childNodes.find((node) => node.name === name);
  }

  children(name) {
    return this.childNodes.filter((node) => node.name === name);
  }
}

export class XMLParser {
  constructor(document) {
    this.source = String(document);
    this.at = 0;
  }

  parse() {
    const root = new XMLNode('#document', {});
    const stack = [root];
    while (this.at < this.source.length) {
      const open = this.source.indexOf('<', this.at);
      if (open === -1) {
        this.appendText(stack, this.source.slice(this.at));
        break;
      }
      if (open > this.at) this.appendText(stack, this.source.slice(this.at, open));
      this.at = open;
      this.readMarkup(stack);
    }
    if (stack.length !== 1) throw new SyntaxError('unclosed element in XML document');
    // A well-formed document has exactly one top-level element; returning it
    // rather than the synthetic document node is what feedparser.js expects.
    return root.childNodes.length === 1 ? root.childNodes[0] : root;
  }

  appendText(stack, raw) {
    if (stack.length < 2) return;
    stack[stack.length - 1].chunks.push(decodeEntities(raw));
  }

  readMarkup(stack) {
    const source = this.source;
    if (source.startsWith('<!--', this.at)) {
      this.at = this.skipTo('-->', 3);
      return;
    }
    if (source.startsWith('<![CDATA[', this.at)) {
      const end = source.indexOf(']]>', this.at);
      const stop = end === -1 ? source.length : end;
      if (stack.length >= 2) {
        stack[stack.length - 1].chunks.push(source.slice(this.at + 9, stop));
      }
      this.at = end === -1 ? source.length : end + 3;
      return;
    }
    if (source.startsWith('<?', this.at)) {
      this.at = this.skipTo('?>', 2);
      return;
    }
    if (source.startsWith('<!', this.at)) {
      this.at = this.skipTo('>', 1);
      return;
    }
    if (source.startsWith('</', this.at)) {
      const end = source.indexOf('>', this.at);
      if (end === -1) throw new SyntaxError('unterminated end tag');
      const name = localName(source.slice(this.at + 2, end).trim());
      if (stack.length < 2) throw new SyntaxError(`unexpected end tag </${name}>`);
      const open = stack.pop();
      if (open.name !== name) {
        throw new SyntaxError(`end tag </${name}> does not match <${open.name}>`);
      }
      this.at = end + 1;
      return;
    }
    this.readStartTag(stack);
  }

  skipTo(terminator, fallbackOffset) {
    const end = this.source.indexOf(terminator, this.at + fallbackOffset);
    return end === -1 ? this.source.length : end + terminator.length;
  }

  readStartTag(stack) {
    const source = this.source;
    // Scan rather than match with one expression, because an attribute value
    // may legitimately contain '>' and a regex stopping at the first one would
    // truncate the tag.
    let cursor = this.at + 1;
    let quote = null;
    while (cursor < source.length) {
      const ch = source[cursor];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) throw new SyntaxError('unterminated start tag');

    let body = source.slice(this.at + 1, cursor);
    this.at = cursor + 1;

    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);

    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new SyntaxError('start tag with no element name');
    const node = new XMLNode(localName(nameMatch[1]), {});

    const attribute = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    attribute.lastIndex = nameMatch[1].length;
    let found;
    while ((found = attribute.exec(body)) !== null) {
      const value = found[3] ?? found[4] ?? found[5] ?? '';
      node.attributes[localName(found[1])] = decodeEntities(value);
    }

    if (stack.length >= 1) stack[stack.length - 1].childNodes.push(node);
    if (!selfClosing) stack.push(node);
  }
}
