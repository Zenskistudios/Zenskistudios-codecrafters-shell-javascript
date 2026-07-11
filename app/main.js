'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const BUILTIN_NAMES = ['echo', 'exit', 'type', 'pwd', 'cd', 'complete', 'jobs', 'history', 'declare'];
const TAB_COMPLETABLE_BUILTINS = ['echo', 'exit'];

/* -------------------------------------------------------------------------
 * History
 * ---------------------------------------------------------------------- */

class HistoryStore {
  constructor() {
    this.entries = [];
    this.flushedCount = 0; // how many entries have been written via `history -a`
  }

  static formatLine(oneBasedIndex, text) {
    return `${String(oneBasedIndex).padStart(5)}  ${text}`;
  }

  record(line) {
    const trimmed = line.trim();
    if (trimmed.length > 0) this.entries.push(trimmed);
  }

  loadFrom(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return `${filePath}: No such file or directory`;
    }
    raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .forEach((l) => this.entries.push(l));
    return null;
  }

  saveTo(filePath) {
    const body = this.entries.length ? this.entries.join('\n') + '\n' : '';
    try {
      fs.writeFileSync(filePath, body);
    } catch {
      return `${filePath}: No such file or directory`;
    }
    return null;
  }

  flushNewTo(filePath) {
    const fresh = this.entries.slice(this.flushedCount);
    const body = fresh.length ? fresh.join('\n') + '\n' : '';
    try {
      fs.appendFileSync(filePath, body);
    } catch {
      return `${filePath}: No such file or directory`;
    }
    this.flushedCount = this.entries.length;
    return null;
  }

  list(limit) {
    const from = Number.isInteger(limit) && limit >= 0
      ? Math.max(0, this.entries.length - limit)
      : 0;
    const lines = [];
    for (let i = from; i < this.entries.length; i++) {
      lines.push(HistoryStore.formatLine(i + 1, this.entries[i]));
    }
    return lines;
  }
}

/* -------------------------------------------------------------------------
 * Jobs
 * ---------------------------------------------------------------------- */

class JobTable {
  constructor() {
    this.byNumber = new Map();
    this.current = null;  // job marked '+'
    this.previous = null; // job marked '-'
  }

  #nextNumber() {
    if (this.byNumber.size === 0) return 1;
    return Math.max(...this.byNumber.keys()) + 1;
  }

  marker(job) {
    if (job === this.current) return '+';
    if (job === this.previous) return '-';
    return ' ';
  }

  add(commandLine, pid) {
    const job = { number: this.#nextNumber(), pid, command: commandLine, status: 'Running' };
    this.previous = this.current;
    this.current = job;
    this.byNumber.set(job.number, job);
    return job;
  }

  #promoteAfterRemoving(job) {
    if (job === this.current) {
      this.current = this.previous;
      this.previous = null;
      for (const candidate of [...this.byNumber.values()].reverse()) {
        if (candidate !== this.current) {
          this.previous = candidate;
          break;
        }
      }
    } else if (job === this.previous) {
      this.previous = null;
      for (const candidate of [...this.byNumber.values()].reverse()) {
        if (candidate !== this.current) {
          this.previous = candidate;
          break;
        }
      }
    }
  }

  remove(job) {
    this.byNumber.delete(job.number);
    this.#promoteAfterRemoving(job);
  }

  all() {
    return [...this.byNumber.values()];
  }

  formatLine(job) {
    const status = job.status.padEnd(24);
    const display = job.status === 'Done' ? job.command.replace(/\s*&$/, '') : job.command;
    return `[${job.number}]${this.marker(job)}  ${status}${display}`;
  }

  // Emits a formatted line for every currently-Done job, then removes them.
  drainDone(emit) {
    for (const job of this.all().filter((j) => j.status === 'Done')) {
      emit(this.formatLine(job));
      this.remove(job);
    }
  }
}

const historyStore = new HistoryStore();
const jobTable = new JobTable();
const completionScripts = new Map(); // command name -> completer script path
const shellVars = new Map();

/* -------------------------------------------------------------------------
 * Tab completion helpers
 * ---------------------------------------------------------------------- */

function executablesStartingWith(prefix) {
  const found = new Set();
  for (const dir of process.env.PATH.split(path.delimiter)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        found.add(name);
      } catch {
        /* not executable */
      }
    }
  }
  return found;
}

function filenamesStartingWith(prefix) {
  const found = new Set();
  const slash = prefix.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : prefix.slice(0, slash + 1);
  const namePart = slash === -1 ? prefix : prefix.slice(slash + 1);
  const searchDir = dirPart === '' ? '.' : dirPart;

  let names;
  try {
    names = fs.readdirSync(searchDir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name.startsWith(namePart)) found.add(dirPart + name);
  }
  return found;
}

function commonPrefixOf(strings) {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    let k = 0;
    while (k < prefix.length && k < s.length && prefix[k] === s[k]) k++;
    prefix = prefix.slice(0, k);
    if (!prefix) break;
  }
  return prefix;
}

let ambiguousPromptSeenFor = null; // last text for which we've already rung the bell once

// Turns a candidate set into a readline completion tuple. `suffixFor(hit)`
// decides what to append on a single unambiguous match ('/' for a dir, ' '
// otherwise); `skipPrefixGrow` disables the longer-common-prefix step
// (used for completer-script output).
function buildCompletionResult(candidates, wordBeingCompleted, suffixFor = () => ' ', skipPrefixGrow = false) {
  if (candidates.length === 1) {
    ambiguousPromptSeenFor = null;
    return [[candidates[0] + suffixFor(candidates[0])], wordBeingCompleted];
  }

  if (candidates.length === 0) {
    ambiguousPromptSeenFor = null;
    process.stdout.write('\x07');
    return [[], wordBeingCompleted];
  }

  if (!skipPrefixGrow) {
    const grown = commonPrefixOf(candidates);
    if (grown.length > wordBeingCompleted.length) {
      ambiguousPromptSeenFor = null;
      return [[grown], wordBeingCompleted];
    }
  }

  if (ambiguousPromptSeenFor !== wordBeingCompleted) {
    ambiguousPromptSeenFor = wordBeingCompleted;
    process.stdout.write('\x07');
    return [[], wordBeingCompleted];
  }

  const rendered = candidates.map((c) => (suffixFor(c) === '/' ? c + '/' : c));
  process.stdout.write('\n' + rendered.join('  ') + '\n');
  replLine._refreshLine();
  return [[], wordBeingCompleted];
}

function tabComplete(line) {
  const lastSpace = line.lastIndexOf(' ');

  if (lastSpace === -1) {
    const builtinMatches = TAB_COMPLETABLE_BUILTINS.filter((b) => b.startsWith(line));
    const execMatches = line.length > 0 ? executablesStartingWith(line) : new Set();
    const merged = Array.from(new Set([...builtinMatches, ...execMatches])).sort();
    return buildCompletionResult(merged, line);
  }

  const wordPrefix = line.slice(lastSpace + 1);
  const firstSpace = line.indexOf(' ');
  const commandName = line.slice(0, firstSpace);

  if (completionScripts.has(commandName)) {
    const script = completionScripts.get(commandName);
    const before = line.slice(0, lastSpace).split(/\s+/).filter(Boolean);
    const prevWord = before.length ? before[before.length - 1] : '';

    const result = spawnSync(script, [commandName, wordPrefix, prevWord], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COMP_LINE: line,
        COMP_POINT: String(Buffer.byteLength(line, 'utf8')),
      },
    });

    if (!result.error) {
      const scriptHits = (result.stdout || '').split('\n').filter((l) => l.length > 0).sort();
      if (scriptHits.length > 0) return buildCompletionResult(scriptHits, wordPrefix, () => ' ', true);
    }
  }

  const suffixFor = (hit) => {
    try {
      return fs.statSync(hit).isDirectory() ? '/' : ' ';
    } catch {
      return ' ';
    }
  };
  const fileHits = Array.from(filenamesStartingWith(wordPrefix)).sort();
  return buildCompletionResult(fileHits, wordPrefix, suffixFor);
}

const replLine = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '$ ',
  completer: tabComplete,
});

/* -------------------------------------------------------------------------
 * Prompt / job reaping
 * ---------------------------------------------------------------------- */

function showPrompt() {
  jobTable.drainDone((line) => console.log(line));
  replLine.prompt();
}

function locateExecutable(name) {
  for (const dir of process.env.PATH.split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Parsing (quotes, escapes, variable expansion, tokens)
 * ---------------------------------------------------------------------- */

function lookupVariableAt(text, at) {
  if (text[at + 1] === '{') {
    const close = text.indexOf('}', at + 2);
    if (close === -1) return null;
    const name = text.slice(at + 2, close);
    return { value: shellVars.get(name) ?? '', nextIndex: close + 1 };
  }

  let j = at + 1;
  if (j >= text.length || !/[A-Za-z_]/.test(text[j])) return null;
  let name = text[j];
  j++;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) {
    name += text[j];
    j++;
  }
  return { value: shellVars.get(name) ?? '', nextIndex: j };
}

function tokenize(input) {
  const tokens = [];
  let word = '';
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else word += ch;
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < input.length && ['"', '\\', '$', '`'].includes(input[i + 1])) {
        word += input[i + 1];
        i++;
      } else if (ch === '$') {
        const expanded = lookupVariableAt(input, i);
        if (expanded) {
          word += expanded.value;
          i = expanded.nextIndex - 1;
        } else {
          word += ch;
        }
      } else {
        word += ch;
      }
      continue;
    }

    if (ch === '\\') {
      if (i + 1 < input.length) {
        word += input[i + 1];
        i++;
        hasContent = true;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasContent = true;
    } else if (ch === '"') {
      inDouble = true;
      hasContent = true;
    } else if (ch === '$') {
      const expanded = lookupVariableAt(input, i);
      if (expanded) {
        word += expanded.value;
        i = expanded.nextIndex - 1;
        if (expanded.value.length > 0) hasContent = true;
      } else {
        word += ch;
        hasContent = true;
      }
    } else if (/\s/.test(ch)) {
      if (hasContent) {
        tokens.push(word);
        word = '';
        hasContent = false;
      }
    } else {
      word += ch;
      hasContent = true;
    }
  }

  if (hasContent) tokens.push(word);
  return tokens;
}

// Pulls '>','1>','>>','1>>','2>','2>>' redirections out of a token list.
function splitRedirections(tokens) {
  const args = [];
  const redir = { stdoutFile: null, stdoutAppend: false, stderrFile: null, stderrAppend: false };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '>' || t === '1>') {
      redir.stdoutFile = tokens[++i];
      redir.stdoutAppend = false;
    } else if (t === '>>' || t === '1>>') {
      redir.stdoutFile = tokens[++i];
      redir.stdoutAppend = true;
    } else if (t === '2>') {
      redir.stderrFile = tokens[++i];
      redir.stderrAppend = false;
    } else if (t === '2>>') {
      redir.stderrFile = tokens[++i];
      redir.stderrAppend = true;
    } else {
      args.push(t);
    }
  }

  return { args, ...redir };
}

/* -------------------------------------------------------------------------
 * Builtins (captured form, used by both single-command and pipeline paths)
 * ---------------------------------------------------------------------- */

function runBuiltinCaptured(name, args) {
  const out = [];
  const err = [];
  let wantsExit = false;

  const resolveCdTarget = (raw) => {
    if (raw === undefined) return process.env.HOME;
    if (raw === '~') return process.env.HOME;
    if (raw.startsWith('~/')) return path.join(process.env.HOME, raw.slice(2));
    return raw;
  };

  switch (name) {
    case 'exit':
      wantsExit = true;
      break;

    case 'echo':
      out.push(args.join(' '));
      break;

    case 'pwd':
      out.push(process.cwd());
      break;

    case 'cd':
      try {
        process.chdir(resolveCdTarget(args[0]));
      } catch {
        err.push(`cd: ${args[0]}: No such file or directory`);
      }
      break;

    case 'type': {
      const target = args[0];
      if (BUILTIN_NAMES.includes(target)) {
        out.push(`${target} is a shell builtin`);
      } else {
        const exe = locateExecutable(target);
        if (exe) out.push(`${target} is ${exe}`);
        else err.push(`${target}: not found`);
      }
      break;
    }

    case 'complete':
      if (args[0] === '-C') {
        completionScripts.set(args[2], args[1]);
      } else if (args[0] === '-r') {
        completionScripts.delete(args[1]);
      } else if (args[0] === '-p') {
        const target = args[1];
        if (completionScripts.has(target)) out.push(`complete -C '${completionScripts.get(target)}' ${target}`);
        else err.push(`complete: ${target}: no completion specification`);
      }
      break;

    case 'jobs':
      for (const job of jobTable.all()) out.push(jobTable.formatLine(job));
      jobTable.drainDone(() => {}); // already reported above; just clear them
      break;

    case 'history':
      if (args[0] === '-r') {
        const e = historyStore.loadFrom(args[1]);
        if (e) err.push(`history: ${e}`);
      } else if (args[0] === '-w') {
        const e = historyStore.saveTo(args[1]);
        if (e) err.push(`history: ${e}`);
      } else if (args[0] === '-a') {
        const e = historyStore.flushNewTo(args[1]);
        if (e) err.push(`history: ${e}`);
      } else {
        const n = args[0] !== undefined ? Number(args[0]) : NaN;
        out.push(...historyStore.list(n));
      }
      break;

    case 'declare':
      if (args[0] === '-p') {
        const varName = args[1];
        if (shellVars.has(varName)) out.push(`declare -- ${varName}="${shellVars.get(varName)}"`);
        else err.push(`declare: ${varName}: not found`);
      } else {
        for (const arg of args) {
          const eq = arg.indexOf('=');
          if (eq === -1) continue;
          const varName = arg.slice(0, eq);
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
            err.push(`declare: \`${arg}': not a valid identifier`);
            continue;
          }
          shellVars.set(varName, arg.slice(eq + 1));
        }
      }
      break;
  }

  return { out, err, wantsExit };
}

/* -------------------------------------------------------------------------
 * Pipeline execution (builtins + externals mixed)
 * ---------------------------------------------------------------------- */

function runPipeline(segments) {
  const stages = [];

  for (const rawTokens of segments) {
    const { args, ...redir } = splitRedirections(rawTokens);
    const name = args[0];

    if (!name) {
      showPrompt();
      return;
    }

    if (BUILTIN_NAMES.includes(name)) {
      stages.push({ kind: 'builtin', name, args: args.slice(1), ...redir });
      continue;
    }

    const exe = locateExecutable(name);
    if (!exe) {
      console.error(`${name}: command not found`);
      showPrompt();
      return;
    }

    stages.push({ kind: 'external', name, exe, args: args.slice(1), ...redir });
  }

  const openFds = [];
  const openFd = (file, append) => {
    try {
      const fd = fs.openSync(file, append ? 'a' : 'w');
      openFds.push(fd);
      return fd;
    } catch {
      return null;
    }
  };
  const closeFds = () => {
    for (const fd of openFds) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  };

  const spawnedChildren = [];
  let pendingBuiltinOutput = null;
  let unconsumedExternalStdout = null;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isFirst = i === 0;
    const isLast = i === stages.length - 1;

    if (stage.kind === 'builtin') {
      if (unconsumedExternalStdout) {
        unconsumedExternalStdout.resume();
        unconsumedExternalStdout = null;
      }
      pendingBuiltinOutput = null;

      const { out, err, wantsExit } = runBuiltinCaptured(stage.name, stage.args);
      const outText = out.length ? out.join('\n') + '\n' : '';
      const errText = err.length ? err.join('\n') + '\n' : '';

      if (stage.stderrFile) {
        const fd = openFd(stage.stderrFile, stage.stderrAppend);
        if (fd !== null && errText) fs.writeSync(fd, errText);
      } else if (errText) {
        process.stderr.write(errText);
      }

      if (stage.stdoutFile) {
        const fd = openFd(stage.stdoutFile, stage.stdoutAppend);
        if (fd !== null && outText) fs.writeSync(fd, outText);
      } else if (isLast) {
        if (outText) process.stdout.write(outText);
      } else {
        pendingBuiltinOutput = outText;
      }

      if (wantsExit) {
        closeFds();
        replLine.close();
        return;
      }
      continue;
    }

    let stdin = isFirst ? 'inherit' : 'pipe';
    let stdout = isLast ? 'inherit' : 'pipe';
    let stderr = 'inherit';

    if (stage.stdoutFile) {
      const fd = openFd(stage.stdoutFile, stage.stdoutAppend);
      if (fd === null) {
        console.error(`${stage.name}: ${stage.stdoutFile}: No such file or directory`);
        closeFds();
        showPrompt();
        return;
      }
      stdout = fd;
    }

    if (stage.stderrFile) {
      const fd = openFd(stage.stderrFile, stage.stderrAppend);
      if (fd === null) {
        console.error(`${stage.name}: ${stage.stderrFile}: No such file or directory`);
        closeFds();
        showPrompt();
        return;
      }
      stderr = fd;
    }

    let child;
    try {
      child = spawn(stage.exe, stage.args, { stdio: [stdin, stdout, stderr], argv0: stage.name });
    } catch {
      console.error(`${stage.name}: command not found`);
      closeFds();
      showPrompt();
      return;
    }
    child.on('error', () => {});

    if (!isFirst) {
      if (unconsumedExternalStdout) {
        unconsumedExternalStdout.on('error', () => {});
        if (child.stdin) child.stdin.on('error', () => {});
        unconsumedExternalStdout.pipe(child.stdin);
        unconsumedExternalStdout = null;
      } else if (pendingBuiltinOutput !== null) {
        if (child.stdin) {
          child.stdin.on('error', () => {});
          child.stdin.write(pendingBuiltinOutput);
          child.stdin.end();
        }
        pendingBuiltinOutput = null;
      } else if (child.stdin) {
        child.stdin.end();
      }
    }

    spawnedChildren.push(child);
    unconsumedExternalStdout = isLast ? null : child.stdout;
  }

  const finalStage = stages[stages.length - 1];

  if (finalStage.kind === 'builtin') {
    if (spawnedChildren.length > 0) {
      spawnedChildren[spawnedChildren.length - 1].on('close', () => {
        closeFds();
        showPrompt();
      });
    } else {
      closeFds();
      showPrompt();
    }
    return;
  }

  spawnedChildren[spawnedChildren.length - 1].on('close', () => {
    closeFds();
    showPrompt();
  });
}

/* -------------------------------------------------------------------------
 * Startup
 * ---------------------------------------------------------------------- */

if (process.env.HISTFILE) {
  historyStore.loadFrom(process.env.HISTFILE);
  historyStore.flushedCount = historyStore.entries.length;
}

showPrompt();

replLine.on('line', (input) => {
  const rawTokens = tokenize(input);

  if (rawTokens.length === 0) {
    showPrompt();
    return;
  }

  historyStore.record(input);

  let background = false;
  if (rawTokens[rawTokens.length - 1] === '&') {
    background = true;
    rawTokens.pop();
  }

  if (rawTokens.length === 0) {
    showPrompt();
    return;
  }

  const segments = [[]];
  for (const tok of rawTokens) {
    if (tok === '|') segments.push([]);
    else segments[segments.length - 1].push(tok);
  }

  if (segments.length > 1) {
    runPipeline(segments);
    return;
  }

  const { args: parts, stdoutFile, stdoutAppend, stderrFile, stderrAppend } = splitRedirections(rawTokens);
  if (parts.length === 0) {
    showPrompt();
    return;
  }

  const command = parts[0];
  const args = parts.slice(1);

  const touch = (file, append) => {
    try {
      if (append) {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '');
      } else {
        fs.writeFileSync(file, '');
      }
      return true;
    } catch {
      console.error(`${command}: ${file}: No such file or directory`);
      return false;
    }
  };

  const emitOut = (text) => {
    if (stdoutFile) fs.appendFileSync(stdoutFile, text + '\n');
    else console.log(text);
  };
  const emitErr = (text) => {
    if (stderrFile) fs.appendFileSync(stderrFile, text + '\n');
    else console.error(text);
  };

  if (stdoutFile && !touch(stdoutFile, stdoutAppend)) {
    showPrompt();
    return;
  }
  if (stderrFile && !touch(stderrFile, stderrAppend)) {
    showPrompt();
    return;
  }

  if (command === 'exit') {
    replLine.close();
    return;
  }

  if (command === 'echo') {
    emitOut(args.join(' '));
    showPrompt();
    return;
  }

  if (command === 'pwd') {
    emitOut(process.cwd());
    showPrompt();
    return;
  }

  if (command === 'cd') {
    let target = args[0] === undefined ? process.env.HOME : args[0];
    if (target === '~') target = process.env.HOME;
    else if (target.startsWith('~/')) target = path.join(process.env.HOME, target.slice(2));

    try {
      process.chdir(target);
    } catch {
      emitErr(`cd: ${args[0]}: No such file or directory`);
    }
    showPrompt();
    return;
  }

  if (command === 'type') {
    const target = args[0];
    if (BUILTIN_NAMES.includes(target)) {
      emitOut(`${target} is a shell builtin`);
    } else {
      const exe = locateExecutable(target);
      if (exe) emitOut(`${target} is ${exe}`);
      else emitErr(`${target}: not found`);
    }
    showPrompt();
    return;
  }

  if (command === 'complete') {
    if (args[0] === '-C') {
      completionScripts.set(args[2], args[1]);
    } else if (args[0] === '-r') {
      completionScripts.delete(args[1]);
    } else if (args[0] === '-p') {
      const target = args[1];
      if (completionScripts.has(target)) emitOut(`complete -C '${completionScripts.get(target)}' ${target}`);
      else emitErr(`complete: ${target}: no completion specification`);
    }
    showPrompt();
    return;
  }

  if (command === 'history') {
    if (args[0] === '-r') {
      const e = historyStore.loadFrom(args[1]);
      if (e) emitErr(`history: ${e}`);
      showPrompt();
      return;
    }
    if (args[0] === '-w') {
      const e = historyStore.saveTo(args[1]);
      if (e) emitErr(`history: ${e}`);
      showPrompt();
      return;
    }
    if (args[0] === '-a') {
      const e = historyStore.flushNewTo(args[1]);
      if (e) emitErr(`history: ${e}`);
      showPrompt();
      return;
    }
    const n = args[0] !== undefined ? Number(args[0]) : NaN;
    for (const line of historyStore.list(n)) emitOut(line);
    showPrompt();
    return;
  }

  if (command === 'declare') {
    if (args[0] === '-p') {
      const varName = args[1];
      if (shellVars.has(varName)) emitOut(`declare -- ${varName}="${shellVars.get(varName)}"`);
      else emitErr(`declare: ${varName}: not found`);
      showPrompt();
      return;
    }
    for (const arg of args) {
      const eq = arg.indexOf('=');
      if (eq === -1) continue;
      const varName = arg.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
        emitErr(`declare: \`${arg}': not a valid identifier`);
        continue;
      }
      shellVars.set(varName, arg.slice(eq + 1));
    }
    showPrompt();
    return;
  }

  if (command === 'jobs') {
    for (const job of jobTable.all()) emitOut(jobTable.formatLine(job));
    jobTable.drainDone(() => {});
    showPrompt();
    return;
  }

  const exe = locateExecutable(command);

  if (!exe) {
    emitErr(`${command}: command not found`);
    showPrompt();
    return;
  }

  const stdoutMode = stdoutAppend ? 'a' : 'w';
  const stderrMode = stderrAppend ? 'a' : 'w';

  if (background) {
    try {
      const outFd = stdoutFile ? fs.openSync(stdoutFile, stdoutMode) : 'inherit';
      const errFd = stderrFile ? fs.openSync(stderrFile, stderrMode) : 'inherit';

      const child = spawn(exe, args, { stdio: ['inherit', outFd, errFd], argv0: command });
      const job = jobTable.add(input.trim(), child.pid);
      child.on('exit', () => {
        job.status = 'Done';
      });

      console.log(`[${job.number}] ${child.pid}`);
    } catch {
      console.error(`${command}: ${stdoutFile || stderrFile}: No such file or directory`);
    }
    showPrompt();
    return;
  }

  try {
    const outFd = stdoutFile ? fs.openSync(stdoutFile, stdoutMode) : 'inherit';
    const errFd = stderrFile ? fs.openSync(stderrFile, stderrMode) : 'inherit';

    spawnSync(exe, args, { stdio: ['inherit', outFd, errFd], argv0: command });

    if (typeof outFd === 'number') fs.closeSync(outFd);
    if (typeof errFd === 'number') fs.closeSync(errFd);
  } catch {
    console.error(`${command}: ${stdoutFile || stderrFile}: No such file or directory`);
  }

  showPrompt();
});

replLine.on('close', () => {
  if (process.env.HISTFILE) historyStore.saveTo(process.env.HISTFILE);
  process.exit(0);
});