// Stands in for argparse, for the parser main() builds: five optional
// arguments, three of them in a required mutually exclusive group, plus the
// automatic -h and the version action.
//
// The CLI's text is part of what this tool is. Its usage line, its help body,
// its version line and each of its error messages are argparse's, not this
// repository's, and a port that reaches for a JS option parser produces
// different text for every one of them. So the layout is reproduced: the usage
// line assembled from bracketed parts and re-wrapped by argparse's own
// packing algorithm, the help body laid out in argparse's two columns, and the
// errors spelled the way argparse spells them.
//
// Three details the capture settles that a reading of the source would not.
// The group's members are declared non-contiguously -- -d is added to the
// parser between -r and -m -- and the usage line therefore lists them among
// all the others with no bracket marking the group. An unknown flag is
// reported as the group being unsatisfied rather than as an unrecognised
// argument, because the required-group check runs before the leftovers are
// examined. And the width is 78 whenever output is not a terminal, which is
// what fixes the column the help text wraps at.
//
// Every string this file produces was captured by executing CPython 3.11
// against the original parser; see
// ../../github-dorks-parity-harness/probe_argparse.py.

import { PyError } from './pyerrors.js';
import { sys } from './pysys.js';
import { TextWrapper, wrap } from './pytextwrap.js';

// What parse_args() raises rather than returning. The source never catches it,
// so it reaches the interpreter and becomes the process's exit status.
export class SystemExit extends PyError {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function actionName(action) {
  if (action.optionStrings.length) return action.optionStrings.join('/');
  return action.metavar ?? action.dest;
}

class Action {
  constructor({ optionStrings, dest, help = null, metavar = null, kind = 'store', version = null }) {
    this.optionStrings = optionStrings;
    this.dest = dest;
    this.help = help;
    this.metavar = metavar;
    this.kind = kind;
    this.version = version;
    this.required = false;
    this.nargs = kind === 'store' ? null : 0;
  }

  formatArg() {
    if (this.nargs === 0) return null;
    return this.metavar ?? this.dest.toUpperCase();
  }
}

function formatActionInvocationUsage(action) {
  const arg = action.formatArg();
  const head = action.optionStrings[0];
  return arg === null ? head : `${head} ${arg}`;
}

// _format_action_invocation: every option string, with the argument repeated
// after each one.
function formatActionInvocation(action) {
  const arg = action.formatArg();
  if (arg === null) return action.optionStrings.join(', ');
  return action.optionStrings.map((option) => `${option} ${arg}`).join(', ');
}

// _format_usage's inner get_lines: pack parts into lines no wider than
// textWidth, joined by single spaces. The first line is charged the prefix's
// width instead of the indent's, and is then un-indented, which is why the
// continuation lines align under the program name rather than under 'usage:'.
function getLines(parts, indent, prefix, textWidth) {
  const lines = [];
  let line = [];
  let lineLen = (prefix === null ? indent.length : prefix.length) - 1;

  for (const part of parts) {
    if (lineLen + 1 + part.length > textWidth && line.length) {
      lines.push(indent + line.join(' '));
      line = [];
      lineLen = indent.length - 1;
    }
    line.push(part);
    lineLen += 1 + part.length;
  }
  if (line.length) lines.push(indent + line.join(' '));
  if (prefix !== null) lines[0] = lines[0].slice(indent.length);
  return lines;
}

// HelpFormatter.format_help's final pass: runs of three or more newlines
// collapse to two, then the whole text is stripped of leading and trailing
// newlines. Applied to every section argparse hands back, which is why no
// section ever carries the blank lines its own formatter left on it.
function trimBlankLines(text) {
  return text.replace(/\n\n\n+/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

export class ArgumentParser {
  constructor({ prog = 'prog', description = null, epilog = null, addHelp = true } = {}) {
    this.prog = prog;
    this.description = description;
    this.epilog = epilog;
    this.actions = [];
    this.groups = [];

    // HelpFormatter's width is the terminal's columns less two, and
    // shutil.get_terminal_size falls back to 80 whenever output is not a
    // terminal -- which is every run whose text anything compares.
    this.width = 78;

    if (addHelp) {
      this.addArgument(['-h', '--help'], {
        dest: 'help',
        kind: 'help',
        help: 'show this help message and exit',
      });
    }
  }

  addArgument(optionStrings, { dest = null, help = null, metavar = null, kind = 'store', version = null } = {}) {
    const long = optionStrings.find((option) => option.startsWith('--'));
    const resolvedDest = dest
      ?? (long ?? optionStrings[0]).replace(/^--?/, '').replace(/-/g, '_');
    const action = new Action({
      optionStrings,
      dest: resolvedDest,
      help: help ?? (kind === 'version' ? "show program's version number and exit" : null),
      metavar,
      kind,
      version,
    });
    this.actions.push(action);
    return action;
  }

  addMutuallyExclusiveGroup({ required = false } = {}) {
    const group = new MutuallyExclusiveGroup(this, required);
    this.groups.push(group);
    return group;
  }

  groupOf(action) {
    return this.groups.find((group) => group.actions.includes(action)) ?? null;
  }

  // _format_usage's own result, which ends in a blank line so that the section
  // after it in the help body is separated from it.
  usageSection() {
    const prefix = 'usage: ';
    const parts = this.actions.map((action) => {
      const invocation = formatActionInvocationUsage(action);
      return action.required ? invocation : `[${invocation}]`;
    });

    let usage = [this.prog, ...parts].join(' ');
    if (prefix.length + usage.length > this.width) {
      const indent = ' '.repeat(prefix.length + this.prog.length + 1);
      usage = getLines([this.prog, ...parts], indent, prefix, this.width).join('\n');
    }
    return `${prefix}${usage}\n\n`;
  }

  // format_usage() puts that section through HelpFormatter.format_help, which
  // trims it to exactly one trailing newline -- so the usage printed before an
  // error message is followed by the message directly, with no blank line, even
  // though the same usage inside the help body keeps one.
  formatUsage() {
    return `${trimBlankLines(this.usageSection())}\n`;
  }

  // HelpFormatter._format_action. The help column sits at 24, the invocation
  // shares the first line only when it fits in the 20 columns before it, and
  // the help itself is wrapped to whatever is left.
  formatActionHelp(action) {
    const helpPosition = 24;
    const actionWidth = helpPosition - 2 - 2;
    const helpWidth = Math.max(this.width - helpPosition, 11);
    const invocation = formatActionInvocation(action);

    if (!action.help) return `  ${invocation}\n`;

    const helpLines = wrap(action.help, helpWidth);
    const body = helpLines
      .slice(1)
      .map((line) => `${' '.repeat(helpPosition)}${line}\n`)
      .join('');

    if (invocation.length <= actionWidth) {
      const header = `  ${invocation.padEnd(actionWidth)}  `;
      return `${header}${helpLines[0]}\n${body}`;
    }
    return `  ${invocation}\n${' '.repeat(helpPosition)}${helpLines[0]}\n${body}`;
  }

  // The help body keeps the blank line the usage section ends with, because the
  // trim runs once over the assembled whole rather than over each section.
  formatHelp() {
    const fill = (text) => new TextWrapper({ width: this.width }).fill(text);

    let out = this.usageSection();
    if (this.description) out += `${fill(this.description)}\n\n`;
    out += 'options:\n';
    for (const action of this.actions) out += this.formatActionHelp(action);
    out += '\n';
    if (this.epilog) out += `${fill(this.epilog)}\n\n`;

    return `${trimBlankLines(out)}\n`;
  }

  formatVersion(action) {
    const version = action.version.replace(/%\(prog\)s/g, this.prog);
    return `${trimBlankLines(new TextWrapper({ width: this.width }).fill(version))}\n`;
  }

  printHelp() {
    sys.stdout.write(this.formatHelp());
  }

  printUsage() {
    sys.stderr.write(this.formatUsage());
  }

  error(message) {
    sys.stderr.write(this.formatUsage());
    sys.stderr.write(`${this.prog}: error: ${message}\n`);
    throw new SystemExit(2);
  }

  optionByString(option) {
    return this.actions.find((action) => action.optionStrings.includes(option)) ?? null;
  }

  parseArgs(argv) {
    const namespace = {};
    for (const action of this.actions) {
      if (action.kind === 'store') namespace[action.dest] = null;
    }

    const seen = new Map();
    const extras = [];
    const args = [...argv];

    while (args.length) {
      const token = args.shift();
      if (token === '--') {
        // The marker itself is consumed by the first positional that follows
        // it. This parser has no positionals, so it survives into the
        // leftovers and is reported alongside them.
        extras.push(token, ...args);
        break;
      }
      if (!token.startsWith('-') || token === '-') {
        extras.push(token);
        continue;
      }

      let explicit = null;
      let name = token;
      const equals = token.indexOf('=');
      if (token.startsWith('--') && equals !== -1) {
        name = token.slice(0, equals);
        explicit = token.slice(equals + 1);
      }

      const action = this.optionByString(name) ?? this.abbreviation(name);
      if (action === null) {
        extras.push(token);
        continue;
      }

      if (action.kind === 'help') {
        this.printHelp();
        throw new SystemExit(0);
      }
      if (action.kind === 'version') {
        sys.stdout.write(this.formatVersion(action));
        throw new SystemExit(0);
      }

      let value = explicit;
      if (value === null) {
        // An option's argument may look like an option only when it is a
        // negative number and the parser has no numeric-looking options. This
        // parser has none, so anything starting with '-' ends the option.
        if (args.length === 0 || (args[0].startsWith('-') && args[0].length > 1)) {
          this.error(`argument ${actionName(action)}: expected one argument`);
        }
        value = args.shift();
      }

      this.checkConflict(action, seen);
      namespace[action.dest] = value;
      seen.set(action, token);
    }

    // The required-group check runs before the leftovers are reported, which
    // is why an unknown flag is answered with the group's error rather than
    // with 'unrecognized arguments'.
    this.checkRequiredGroups(seen);

    if (extras.length) this.error(`unrecognized arguments: ${extras.join(' ')}`);

    return namespace;
  }

  abbreviation(name) {
    if (!name.startsWith('--') || name.length <= 2) return null;
    const matches = this.actions.filter((action) =>
      action.optionStrings.some((option) => option.startsWith('--') && option.startsWith(name)));
    return matches.length === 1 ? matches[0] : null;
  }

  checkConflict(action, seen) {
    const group = this.groupOf(action);
    if (group === null) return;
    for (const other of group.actions) {
      if (other !== action && seen.has(other)) {
        this.error(`argument ${actionName(action)}: not allowed with argument ${actionName(other)}`);
      }
    }
  }

  checkRequiredGroups(seen) {
    for (const group of this.groups) {
      if (!group.required) continue;
      if (group.actions.some((action) => seen.has(action))) continue;
      const names = group.actions.map((action) => actionName(action)).join(' ');
      this.error(`one of the arguments ${names} is required`);
    }
  }
}

class MutuallyExclusiveGroup {
  constructor(parser, required) {
    this.parser = parser;
    this.required = required;
    this.actions = [];
  }

  addArgument(optionStrings, options) {
    const action = this.parser.addArgument(optionStrings, options);
    this.actions.push(action);
    return action;
  }
}
