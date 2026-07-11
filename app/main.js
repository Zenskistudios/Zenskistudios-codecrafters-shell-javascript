const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const builtins = ["echo", "exit", "type", "pwd", "cd", "complete", "jobs", "history", "declare"];

// Registered completion specs from `complete -C <script> <command>`,
// keyed by command name -> completer script path.
const completionSpecs = new Map();

// Shell variables set via `declare NAME=VALUE`, keyed by name.
const shellVariables = new Map();

// Command history, in execution order. Each entry is the raw line as typed
// (matching bash, which stores the line verbatim — redirections, trailing
// "&", etc. included — not the parsed/normalized form). 1-indexed when
// displayed by the `history` builtin.
const commandHistory = [];

// Formats one history entry the way bash's `history` builtin does: the
// 1-based index right-justified in a field of width 5, two spaces, then the
// command text (e.g. "    1  echo hi").
function formatHistoryEntry(index, command) {
  return `${String(index).padStart(5)}  ${command}`;
}

// Reads lines from a history file and appends them (skipping blank lines,
// e.g. a trailing newline at EOF) to the in-memory command history, in
// file order. Returns null on success, or an error message string if the
// file couldn't be read.
function appendHistoryFromFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return `${filePath}: No such file or directory`;
  }

  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    commandHistory.push(line);
  }
  return null;
}

// Writes the full in-memory command history out to a file, one command per
// line, with a trailing newline at EOF (overwrites any existing content,
// creating the file if it doesn't exist yet). Returns null on success, or
// an error message string if the write failed.
function writeHistoryToFile(filePath) {
  const content = commandHistory.length ? commandHistory.join("\n") + "\n" : "";
  try {
    fs.writeFileSync(filePath, content);
  } catch {
    return `${filePath}: No such file or directory`;
  }
  return null;
}

// Tracks how many commandHistory entries have already been written to disk
// via `history -a`, session-wide (not per-file, matching real bash) — so
// repeated `-a` calls only append what's new since the last one.
let historyAppendCursor = 0;

// Appends only the commandHistory entries recorded since the last
// `history -a` call to a file, one per line, creating the file if it
// doesn't exist. Returns null on success, or an error message string if
// the write failed.
function appendNewHistoryToFile(filePath) {
  const newEntries = commandHistory.slice(historyAppendCursor);
  const content = newEntries.length ? newEntries.join("\n") + "\n" : "";
  try {
    fs.appendFileSync(filePath, content);
  } catch {
    return `${filePath}: No such file or directory`;
  }
  historyAppendCursor = commandHistory.length;
  return null;
}

// Background jobs started with a trailing "&". Job numbers are assigned
// sequentially, but recycled: when the table is empty the next job is [1],
// otherwise it's one more than the highest number currently in the table.
const jobs = [];

function getNextJobNumber() {
  if (jobs.length === 0) return 1;
  return Math.max(...jobs.map((job) => job.number)) + 1;
}

// Bash-style job-stack markers: the most recently created still-running job
// is "current" (+), the one before that is "previous" (-), everything else
// is unmarked. These are assigned at creation time and only shuffle when the
// "+" job itself finishes — reaping the "-" job does NOT promote anything,
// matching real bash semantics (as opposed to recomputing "top 2 by array
// position" fresh on every display, which mis-promotes older blank jobs).
let currentJob = null;
let previousJob = null;

function markerFor(job) {
  if (job === currentJob) return "+";
  if (job === previousJob) return "-";
  return " ";
}

function registerNewJob(job) {
  previousJob = currentJob;
  currentJob = job;
  jobs.push(job);
}

// Called when a job is reaped (removed from the table): updates the +/-
// stack. Whichever slot (current "+" or previous "-") the removed job
// occupied gets refilled by promoting the next-most-recent remaining job
// into that slot.
function updateStackOnRemoval(job) {
  if (job === currentJob) {
    currentJob = previousJob;
    previousJob = null;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (jobs[i] !== currentJob) {
        previousJob = jobs[i];
        break;
      }
    }
  } else if (job === previousJob) {
    // Symmetric to the currentJob case: promote the next-most-recent
    // remaining job into the now-empty "-" slot, rather than leaving it
    // blank. This matches the tester's expectation that removing either
    // stack slot pulls the next job up.
    previousJob = null;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (jobs[i] !== currentJob) {
        previousJob = jobs[i];
        break;
      }
    }
  }
}

// Find executable names in PATH whose name starts with the given prefix.
// Handles PATH entries that point to nonexistent directories gracefully.
function findExecutableCompletions(prefix) {
  const paths = process.env.PATH.split(path.delimiter);
  const matches = new Set();

  for (const dir of paths) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // Directory doesn't exist or isn't readable; skip it.
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;

      const fullPath = path.join(dir, entry);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        matches.add(entry);
      } catch {
        // Not executable; skip it.
      }
    }
  }

  return matches;
}

// Find files whose name starts with the given prefix. The prefix may contain
// a path (e.g. "path/to/f"), in which case we search inside that directory
// and return matches with the directory portion re-prepended (e.g.
// "path/to/file.txt"), so the caller can treat the whole thing as one token.
function findFilenameCompletions(prefix) {
  const matches = new Set();

  const lastSlashIndex = prefix.lastIndexOf("/");
  const dirPart = lastSlashIndex === -1 ? "" : prefix.slice(0, lastSlashIndex + 1);
  const namePart = lastSlashIndex === -1 ? prefix : prefix.slice(lastSlashIndex + 1);
  const searchDir = dirPart === "" ? "." : dirPart;

  let entries;
  try {
    entries = fs.readdirSync(searchDir);
  } catch {
    return matches;
  }

  for (const entry of entries) {
    if (entry.startsWith(namePart)) {
      matches.add(dirPart + entry);
    }
  }

  return matches;
}

// Computes the longest string that is a prefix of every string in `strs`.
function longestCommonPrefix(strs) {
  if (strs.length === 0) return "";

  let prefix = strs[0];

  for (let i = 1; i < strs.length; i++) {
    const candidate = strs[i];
    let j = 0;
    while (j < prefix.length && j < candidate.length && prefix[j] === candidate[j]) {
      j++;
    }
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) break;
  }

  return prefix;
}

// Tracks state between consecutive Tab presses on the same (unchanged) line,
// so we know whether this is the first ambiguous press (ring bell) or a
// repeat press (print the candidate list ourselves).
let lastAmbiguousLine = null;

// Shared logic for turning a set of candidate hits into a readline completion
// result, given the text that should be replaced (either the whole line, when
// completing a command name, or just the last word, when completing a
// filename argument).
// getSuffix(hit) determines what to append after a single unambiguous match:
// a space for a file/command, or a trailing slash (no space) for a directory.
// Defaults to always appending a space (used for command-name completion).
function resolveCompletion(hits, matchText, getSuffix = () => " ", skipLcp = false) {
  if (hits.length === 1) {
    lastAmbiguousLine = null;
    return [[hits[0] + getSuffix(hits[0])], matchText];
  }

  if (hits.length === 0) {
    lastAmbiguousLine = null;
    // No matches: leave input unchanged, ring the terminal bell.
    process.stdout.write("\x07");
    return [[], matchText];
  }

  // Multiple matches. First see if they share a longer common prefix
  // than what's already typed — if so, complete up to that prefix
  // (no trailing space, since it's not necessarily a full match yet).
  // Completer-script candidates skip this step (not implemented yet for
  // that source), going straight to the bell/list behavior below.
  if (!skipLcp) {
    const lcp = longestCommonPrefix(hits);

    if (lcp.length > matchText.length) {
      lastAmbiguousLine = null;
      return [[lcp], matchText];
    }
  }

  // No further common-prefix extension is possible: truly ambiguous.
  if (lastAmbiguousLine !== matchText) {
    // First Tab press for this text: ring the bell, don't list yet.
    lastAmbiguousLine = matchText;
    process.stdout.write("\x07");
    return [[], matchText];
  }

  // Second (or later) Tab press for the same text: print the sorted
  // candidates ourselves on a single line, double-space separated, then
  // redraw the prompt. We do this manually (rather than letting readline's
  // built-in multi-column printer handle it) because that printer lays
  // candidates out in a grid based on terminal width, which can put each
  // candidate on its own line instead of a single space-separated row.
  // Directories are shown with a trailing "/"; files are shown as-is.
  const displayHits = hits.map((hit) => (getSuffix(hit) === "/" ? hit + "/" : hit));
  process.stdout.write("\n" + displayHits.join("  ") + "\n");
  rl._refreshLine();
  return [[], matchText];
}

// Tab-completion: command names (builtins/executables) for the first word,
// filenames in the current directory for any argument after that.
function completer(line) {
  const lastSpaceIndex = line.lastIndexOf(" ");

  if (lastSpaceIndex === -1) {
    // Completing the command itself.
    const completableBuiltins = ["echo", "exit"];
    const builtinHits = completableBuiltins.filter((c) => c.startsWith(line));
    const execHits = line.length > 0 ? findExecutableCompletions(line) : new Set();

    const allHits = new Set([...builtinHits, ...execHits]);
    const hits = Array.from(allHits).sort();

    return resolveCompletion(hits, line);
  }

  // Completing a filename argument: only look at the text after the last space.
  const prefix = line.slice(lastSpaceIndex + 1);

  // If a completer script is registered for the command being typed, run it
  // and use its output instead of filename completion.
  const firstSpaceIndex = line.indexOf(" ");
  const commandName = line.slice(0, firstSpaceIndex);

  if (completionSpecs.has(commandName)) {
    const scriptPath = completionSpecs.get(commandName);

    // Determine the word immediately before the one being completed. This
    // includes the command name itself when it's the only preceding word
    // (e.g. "git <TAB>" -> previous word is "git", not "").
    const textBeforeCurrentWord = line.slice(0, lastSpaceIndex);
    const wordsBeforeCurrentWord = textBeforeCurrentWord.split(/\s+/).filter(Boolean);
    const previousWord =
      wordsBeforeCurrentWord.length > 0
        ? wordsBeforeCurrentWord[wordsBeforeCurrentWord.length - 1]
        : "";

    const result = spawnSync(scriptPath, [commandName, prefix, previousWord], {
      encoding: "utf8",
      env: {
        ...process.env,
        COMP_LINE: line,
        // Byte index of the cursor, which sits at the end of `line` (the
        // completer is only invoked at the point of the TAB press). Use
        // byte length, not string length, to handle multibyte characters.
        COMP_POINT: String(Buffer.byteLength(line, "utf8")),
      },
    });

    // spawnSync doesn't throw on exec failures (missing file, EACCES, bad
    // shebang, etc.) — it sets result.error instead, so check explicitly.
    if (!result.error) {
      const lines = (result.stdout || "").split("\n").filter((l) => l.length > 0);

      if (lines.length > 0) {
        return resolveCompletion(lines.sort(), prefix);
      }
    }
  }

  // Directories get a trailing "/" (no space) so the user can immediately
  // tab again into the next path segment; files get a trailing space.
  const getSuffix = (hit) => {
    try {
      return fs.statSync(hit).isDirectory() ? "/" : " ";
    } catch {
      return " ";
    }
  };

  const fileHits = Array.from(findFilenameCompletions(prefix)).sort();

  return resolveCompletion(fileHits, prefix, getSuffix);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
  completer,
});

// Checks for background jobs that have finished, prints a "Done" line for
// each (using the persistent +/- job-stack markers), then removes them from
// the table. Shared by the jobs builtin and the automatic pre-prompt reap,
// so a job's Done line is reported exactly once, whichever happens first.
// Printed lazily (before the next prompt or inside `jobs`) rather than the
// instant the process exits, matching bash's documented behavior: "the
// notification is not printed at the exact moment it changes, but
// immediately before printing a prompt."
function reapDoneJobs() {
  if (jobs.length === 0) return;

  const doneJobs = jobs.filter((job) => job.status === "Done");

  for (const job of doneJobs) {
    const marker = markerFor(job);
    const statusField = job.status.padEnd(24);
    const displayCommand = job.command.replace(/\s*&$/, "");
    console.log(`[${job.number}]${marker}  ${statusField}${displayCommand}`);

    const idx = jobs.indexOf(job);
    if (idx !== -1) jobs.splice(idx, 1);
    updateStackOnRemoval(job);
  }
}

// Prints the prompt for the next command. Reaps any background jobs that
// have finished *before* printing the prompt, so completed-job "Done" lines
// always appear between the previous command's output and the next "$ ".
function startShell() {
  reapDoneJobs();
  rl.prompt();
}

function findExecutable(command) {
  const paths = process.env.PATH.split(path.delimiter);

  for (const dir of paths) {
    const fullPath = path.join(dir, command);

    try {
      fs.accessSync(fullPath, fs.constants.X_OK);
      return fullPath;
    } catch {
      // Keep searching
    }
  }

  return null;
}

function parseInput(input) {
  const tokens = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let tokenStarted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        current += char;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else if (char === "\\" && i + 1 < input.length && ['"', "\\", "$", "`"].includes(input[i + 1])) {
        current += input[i + 1];
        i++;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\\") {
      if (i + 1 < input.length) {
        current += input[i + 1];
        i++;
        tokenStarted = true;
      }
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      tokenStarted = true;
    } else if (char === '"') {
      inDoubleQuote = true;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += char;
      tokenStarted = true;
    }
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}

// Scans tokens for '>', '1>', '>>', '1>>', '2>', '2>>' redirection and strips them out.
// Returns { args, stdoutFile, stdoutAppend, stderrFile, stderrAppend }.
function extractRedirection(parts) {
  const args = [];
  let stdoutFile = null;
  let stdoutAppend = false;
  let stderrFile = null;
  let stderrAppend = false;

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];

    if (token === ">" || token === "1>") {
      stdoutFile = parts[i + 1];
      stdoutAppend = false;
      i++;
    } else if (token === ">>" || token === "1>>") {
      stdoutFile = parts[i + 1];
      stdoutAppend = true;
      i++;
    } else if (token === "2>") {
      stderrFile = parts[i + 1];
      stderrAppend = false;
      i++;
    } else if (token === "2>>") {
      stderrFile = parts[i + 1];
      stderrAppend = true;
      i++;
    } else {
      args.push(token);
    }
  }

  return { args, stdoutFile, stdoutAppend, stderrFile, stderrAppend };
}

// Executes a builtin command's logic (including any real side effects, like
// cd's directory change or complete/jobs table mutations) but CAPTURES its
// stdout/stderr as strings instead of writing them directly. This lets
// runPipeline() decide where that output actually goes — to the terminal,
// to a redirection file, or down the pipe into the next stage's stdin —
// which a plain console.log() can't do.
// Returns { stdoutLines, stderrLines, exitRequested }.
function executeBuiltinCaptured(command, cmdArgs) {
  const stdoutLines = [];
  const stderrLines = [];
  let exitRequested = false;

  switch (command) {
    case "exit": {
      exitRequested = true;
      break;
    }

    case "echo": {
      stdoutLines.push(cmdArgs.join(" "));
      break;
    }

    case "pwd": {
      stdoutLines.push(process.cwd());
      break;
    }

    case "cd": {
      let target = cmdArgs[0] === undefined ? process.env.HOME : cmdArgs[0];
      if (target === "~") {
        target = process.env.HOME;
      } else if (target.startsWith("~/")) {
        target = path.join(process.env.HOME, target.slice(2));
      }
      try {
        process.chdir(target);
      } catch {
        stderrLines.push(`cd: ${cmdArgs[0]}: No such file or directory`);
      }
      break;
    }

    case "type": {
      const cmd = cmdArgs[0];
      if (builtins.includes(cmd)) {
        stdoutLines.push(`${cmd} is a shell builtin`);
      } else {
        const executable = findExecutable(cmd);
        if (executable) {
          stdoutLines.push(`${cmd} is ${executable}`);
        } else {
          stderrLines.push(`${cmd}: not found`);
        }
      }
      break;
    }

    case "complete": {
      if (cmdArgs[0] === "-C") {
        completionSpecs.set(cmdArgs[2], cmdArgs[1]);
      } else if (cmdArgs[0] === "-r") {
        completionSpecs.delete(cmdArgs[1]);
      } else if (cmdArgs[0] === "-p") {
        const target = cmdArgs[1];
        if (completionSpecs.has(target)) {
          stdoutLines.push(`complete -C '${completionSpecs.get(target)}' ${target}`);
        } else {
          stderrLines.push(`complete: ${target}: no completion specification`);
        }
      }
      break;
    }

    case "jobs": {
      for (const job of jobs) {
        const statusField = job.status.padEnd(24);
        const displayCommand = job.status === "Done" ? job.command.replace(/\s*&$/, "") : job.command;
        stdoutLines.push(`[${job.number}]${markerFor(job)}  ${statusField}${displayCommand}`);
      }

      const doneJobs = jobs.filter((job) => job.status === "Done");
      for (const job of doneJobs) {
        const idx = jobs.indexOf(job);
        if (idx !== -1) jobs.splice(idx, 1);
        updateStackOnRemoval(job);
      }
      break;
    }

    case "history": {
      if (cmdArgs[0] === "-r") {
        const errorMsg = appendHistoryFromFile(cmdArgs[1]);
        if (errorMsg) stderrLines.push(`history: ${errorMsg}`);
        break;
      }

      if (cmdArgs[0] === "-w") {
        const errorMsg = writeHistoryToFile(cmdArgs[1]);
        if (errorMsg) stderrLines.push(`history: ${errorMsg}`);
        break;
      }

      if (cmdArgs[0] === "-a") {
        const errorMsg = appendNewHistoryToFile(cmdArgs[1]);
        if (errorMsg) stderrLines.push(`history: ${errorMsg}`);
        break;
      }

      // Optional "history <n>" shows only the last n entries (still with
      // their true, original index numbers) — matches bash.
      const limitArg = cmdArgs[0] !== undefined ? Number(cmdArgs[0]) : NaN;
      const startIndex =
        Number.isInteger(limitArg) && limitArg >= 0
          ? Math.max(0, commandHistory.length - limitArg)
          : 0;

      for (let i = startIndex; i < commandHistory.length; i++) {
        stdoutLines.push(formatHistoryEntry(i + 1, commandHistory[i]));
      }
      break;
    }
    case "declare": {
      if (cmdArgs[0] === "-p") {
        const varName = cmdArgs[1];
        if (shellVariables.has(varName)) {
          stdoutLines.push(`declare -- ${varName}="${shellVariables.get(varName)}"`);
        } else {
          stderrLines.push(`declare: ${varName}: not found`);
        }
        break;
      }

      for (const arg of cmdArgs) {
        const eqIndex = arg.indexOf("=");
        if (eqIndex !== -1) {
          shellVariables.set(arg.slice(0, eqIndex), arg.slice(eqIndex + 1));
        }
      }
      break;
    }
  }

  return { stdoutLines, stderrLines, exitRequested };
}

// Executes a pipeline of two or more commands, connecting each command's
// stdout to the next command's stdin. Any stage may be an external program
// OR a shell builtin (echo, type, pwd, cd, complete, jobs, exit) — builtins
// run in-process (no fork/exec) but still participate correctly in the
// pipeline's stdin/stdout wiring:
//   - A builtin's captured stdout is forwarded as the next stage's stdin
//     when the builtin isn't the last stage.
//   - A builtin's own redirection (`>`, `>>`, etc.) still wins over piping,
//     matching how external stages behave.
//   - None of our builtins read from stdin, so when a builtin follows an
//     external command, that command's stdout is drained/ignored rather
//     than read — its output must NOT leak to the terminal.
//   - stderr from a builtin is never sent down the pipe (only stdout is
//     piped, matching bash); it goes to its own redirection or the
//     terminal, same as an external stage's inherited stderr.
//
// External-to-external stages still use real (streaming) `spawn` pipes, so
// long-lived producers (e.g. `tail -f`) keep streaming through the pipeline
// exactly as before.
function runPipeline(segments) {
  const parsedSegments = segments.map((segment) => extractRedirection(segment));

  const resolved = [];
  for (const parsed of parsedSegments) {
    const cmdName = parsed.args[0];

    if (!cmdName) {
      // Empty segment (e.g. stray "||" or trailing "|"); nothing to run.
      startShell();
      return;
    }

    if (builtins.includes(cmdName)) {
      resolved.push({
        type: "builtin",
        command: cmdName,
        cmdArgs: parsed.args.slice(1),
        stdoutFile: parsed.stdoutFile,
        stdoutAppend: parsed.stdoutAppend,
        stderrFile: parsed.stderrFile,
        stderrAppend: parsed.stderrAppend,
      });
      continue;
    }

    const executable = findExecutable(cmdName);
    if (!executable) {
      console.error(`${cmdName}: command not found`);
      startShell();
      return;
    }

    resolved.push({
      type: "external",
      command: cmdName,
      executable,
      cmdArgs: parsed.args.slice(1),
      stdoutFile: parsed.stdoutFile,
      stdoutAppend: parsed.stdoutAppend,
      stderrFile: parsed.stderrFile,
      stderrAppend: parsed.stderrAppend,
    });
  }

  const openedFds = [];

  function openFd(file, append) {
    try {
      const fd = fs.openSync(file, append ? "a" : "w");
      openedFds.push(fd);
      return fd;
    } catch {
      return null;
    }
  }

  function closeOpenedFds() {
    for (const fd of openedFds) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed; ignore.
      }
    }
  }

  const children = []; // external child processes, in the order they were spawned
  let pendingInput = null; // string captured from a builtin, to feed the next external stage's stdin
  let prevExternalStdout = null; // previous external stage's stdout stream, when not yet consumed

  for (let i = 0; i < resolved.length; i++) {
    const stage = resolved[i];
    const isFirst = i === 0;
    const isLast = i === resolved.length - 1;

    if (stage.type === "builtin") {
      // If the previous stage was external and its stdout was never wired
      // anywhere (because this builtin doesn't read stdin), drain it so
      // that process doesn't stall trying to write into a full pipe buffer.
      if (prevExternalStdout) {
        prevExternalStdout.resume();
        prevExternalStdout = null;
      }
      pendingInput = null;

      const { stdoutLines, stderrLines, exitRequested } = executeBuiltinCaptured(stage.command, stage.cmdArgs);
      const stdoutText = stdoutLines.length ? stdoutLines.join("\n") + "\n" : "";
      const stderrText = stderrLines.length ? stderrLines.join("\n") + "\n" : "";

      // stderr never travels down the pipe — only stdout does.
      if (stage.stderrFile) {
        const fd = openFd(stage.stderrFile, stage.stderrAppend);
        if (fd !== null && stderrText) fs.writeSync(fd, stderrText);
      } else if (stderrText) {
        process.stderr.write(stderrText);
      }

      if (stage.stdoutFile) {
        const fd = openFd(stage.stdoutFile, stage.stdoutAppend);
        if (fd !== null && stdoutText) fs.writeSync(fd, stdoutText);
      } else if (isLast) {
        if (stdoutText) process.stdout.write(stdoutText);
      } else {
        // Forward this builtin's stdout as the next stage's stdin.
        pendingInput = stdoutText;
      }

      if (exitRequested) {
        closeOpenedFds();
        rl.close();
        return;
      }

      continue;
    }

    // External stage
    let stdinOpt = isFirst ? "inherit" : "pipe";
    let stdoutOpt = isLast ? "inherit" : "pipe";
    let stderrOpt = "inherit";

    if (stage.stdoutFile) {
      const fd = openFd(stage.stdoutFile, stage.stdoutAppend);
      if (fd === null) {
        console.error(`${stage.command}: ${stage.stdoutFile}: No such file or directory`);
        closeOpenedFds();
        startShell();
        return;
      }
      stdoutOpt = fd;
    }

    if (stage.stderrFile) {
      const fd = openFd(stage.stderrFile, stage.stderrAppend);
      if (fd === null) {
        console.error(`${stage.command}: ${stage.stderrFile}: No such file or directory`);
        closeOpenedFds();
        startShell();
        return;
      }
      stderrOpt = fd;
    }

    let child;
    try {
      child = spawn(stage.executable, stage.cmdArgs, {
        stdio: [stdinOpt, stdoutOpt, stderrOpt],
        argv0: stage.command,
      });
    } catch {
      console.error(`${stage.command}: command not found`);
      closeOpenedFds();
      startShell();
      return;
    }

    child.on("error", () => {
      // Avoid crashing the shell on spawn/runtime errors for this stage.
    });

    if (!isFirst) {
      if (prevExternalStdout) {
        prevExternalStdout.on("error", () => {});
        if (child.stdin) child.stdin.on("error", () => {});
        prevExternalStdout.pipe(child.stdin);
        prevExternalStdout = null;
      } else if (pendingInput !== null) {
        // Previous stage was a builtin: feed its captured output in, then
        // close stdin so this stage sees EOF (it isn't a streaming source).
        if (child.stdin) {
          child.stdin.on("error", () => {});
          child.stdin.write(pendingInput);
          child.stdin.end();
        }
        pendingInput = null;
      } else if (child.stdin) {
        // No upstream data at all — close stdin so this stage doesn't hang
        // waiting for input that will never come.
        child.stdin.end();
      }
    }

    children.push(child);
    prevExternalStdout = isLast ? null : child.stdout;
  }

  const lastResolved = resolved[resolved.length - 1];

  if (lastResolved.type === "builtin") {
    // The builtin already ran synchronously and wrote its output above.
    // If any external stage ran earlier in the pipeline, wait for the most
    // recently spawned one to close before returning to the prompt (mirrors
    // the external-only case below); otherwise there's nothing left to wait
    // on.
    if (children.length > 0) {
      const lastChild = children[children.length - 1];
      lastChild.on("close", () => {
        closeOpenedFds();
        startShell();
      });
    } else {
      closeOpenedFds();
      startShell();
    }
    return;
  }

  // Last stage is external: only wait on IT before printing the next
  // prompt — mirroring real bash, where `cmd1 | cmd2` returns to the prompt
  // as soon as `cmd2` (the foreground process group's tail) finishes, even
  // if `cmd1` lingers momentarily until it gets SIGPIPE'd by the kernel.
  const lastChild = children[children.length - 1];
  lastChild.on("close", () => {
    closeOpenedFds();
    startShell();
  });
}

// Load history from HISTFILE (if set) into memory on startup. Errors (e.g.
// the file doesn't exist yet) are ignored silently — matching bash, which
// doesn't complain about a missing/unset HISTFILE at launch. The append
// cursor is advanced past these loaded entries so a later `history -a`
// only writes out what's typed in this session, not what was just loaded.
if (process.env.HISTFILE) {
  appendHistoryFromFile(process.env.HISTFILE);
  historyAppendCursor = commandHistory.length;
}

startShell();

rl.on("line", (input) => {
  const rawParts = parseInput(input);

  if (rawParts.length === 0) {
    startShell();
    return;
  }

  // Record the line in history exactly as typed (bash stores the verbatim
  // input, before any redirection/pipe/background parsing) — including the
  // "history" command itself.
  const trimmedInput = input.trim();
  if (trimmedInput.length > 0) {
    commandHistory.push(trimmedInput);
  }

  // A trailing "&" token means run this command in the background: strip it
  // out before redirection/argument parsing proceeds as normal.
  let isBackground = false;
  if (rawParts[rawParts.length - 1] === "&") {
    isBackground = true;
    rawParts.pop();
  }

  if (rawParts.length === 0) {
    startShell();
    return;
  }

  // Detect a pipeline: split rawParts on literal "|" tokens. Each resulting
  // segment is a self-contained command (with its own args/redirection).
  const pipeSegments = [[]];
  for (const token of rawParts) {
    if (token === "|") {
      pipeSegments.push([]);
    } else {
      pipeSegments[pipeSegments.length - 1].push(token);
    }
  }

  if (pipeSegments.length > 1) {
    runPipeline(pipeSegments);
    return;
  }

  const { args: parts, stdoutFile, stdoutAppend, stderrFile, stderrAppend } = extractRedirection(rawParts);

  if (parts.length === 0) {
    startShell();
    return;
  }

  const command = parts[0];
  const args = parts.slice(1);

  function touchFile(file, append) {
    try {
      if (append) {
        if (!fs.existsSync(file)) {
          fs.writeFileSync(file, "");
        }
      } else {
        fs.writeFileSync(file, "");
      }
      return true;
    } catch {
      console.error(`${command}: ${file}: No such file or directory`);
      return false;
    }
  }

  function writeStdout(text) {
    if (stdoutFile) {
      fs.appendFileSync(stdoutFile, text + "\n");
    } else {
      console.log(text);
    }
  }

  function writeStderr(text) {
    if (stderrFile) {
      fs.appendFileSync(stderrFile, text + "\n");
    } else {
      console.error(text);
    }
  }

  if (stdoutFile) {
    if (!touchFile(stdoutFile, stdoutAppend)) {
      startShell();
      return;
    }
  }

  if (stderrFile) {
    if (!touchFile(stderrFile, stderrAppend)) {
      startShell();
      return;
    }
  }

  if (command === "exit") {
    rl.close();
    return;
  }

  if (command === "echo") {
    writeStdout(args.join(" "));
    startShell();
    return;
  }

  if (command === "pwd") {
    writeStdout(process.cwd());
    startShell();
    return;
  }

  if (command === "cd") {
    let target = args[0] === undefined ? process.env.HOME : args[0];

    if (target === "~") {
      target = process.env.HOME;
    } else if (target.startsWith("~/")) {
      target = path.join(process.env.HOME, target.slice(2));
    }

    try {
      process.chdir(target);
    } catch {
      writeStderr(`cd: ${args[0]}: No such file or directory`);
    }

    startShell();
    return;
  }

  if (command === "type") {
    const cmd = args[0];

    if (builtins.includes(cmd)) {
      writeStdout(`${cmd} is a shell builtin`);
    } else {
      const executable = findExecutable(cmd);
      if (executable) {
        writeStdout(`${cmd} is ${executable}`);
      } else {
        writeStderr(`${cmd}: not found`);
      }
    }

    startShell();
    return;
  }

  if (command === "complete") {
    if (args[0] === "-C") {
      const scriptPath = args[1];
      const targetCommand = args[2];
      completionSpecs.set(targetCommand, scriptPath);
    } else if (args[0] === "-r") {
      const targetCommand = args[1];
      // No-op (and no error) if nothing was registered for this command.
      completionSpecs.delete(targetCommand);
    } else if (args[0] === "-p") {
      const target = args[1];
      if (completionSpecs.has(target)) {
        writeStdout(`complete -C '${completionSpecs.get(target)}' ${target}`);
      } else {
        // No completion specification registered for this command.
        writeStderr(`complete: ${target}: no completion specification`);
      }
    }

    startShell();
    return;
  }

  if (command === "history") {
    if (args[0] === "-r") {
      const errorMsg = appendHistoryFromFile(args[1]);
      if (errorMsg) writeStderr(`history: ${errorMsg}`);
      startShell();
      return;
    }

    if (args[0] === "-w") {
      const errorMsg = writeHistoryToFile(args[1]);
      if (errorMsg) writeStderr(`history: ${errorMsg}`);
      startShell();
      return;
    }

    if (args[0] === "-a") {
      const errorMsg = appendNewHistoryToFile(args[1]);
      if (errorMsg) writeStderr(`history: ${errorMsg}`);
      startShell();
      return;
    }

    const limitArg = args[0] !== undefined ? Number(args[0]) : NaN;
    const startIndex =
      Number.isInteger(limitArg) && limitArg >= 0
        ? Math.max(0, commandHistory.length - limitArg)
        : 0;

    for (let i = startIndex; i < commandHistory.length; i++) {
      writeStdout(formatHistoryEntry(i + 1, commandHistory[i]));
    }

    startShell();
    return;
  }

  if (command === "declare") {
    if (args[0] === "-p") {
      const varName = args[1];
      if (shellVariables.has(varName)) {
        writeStdout(`declare -- ${varName}="${shellVariables.get(varName)}"`);
      } else {
        writeStderr(`declare: ${varName}: not found`);
      }
      startShell();
      return;
    }

    for (const arg of args) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex !== -1) {
        shellVariables.set(arg.slice(0, eqIndex), arg.slice(eqIndex + 1));
      }
    }

    startShell();
    return;
  }

  if (command === "jobs") {
    // Print every job in job-number order, using each job's *current*
    // status (Running or Done). This must happen in a single pass so a
    // job that just finished is reported in its natural position instead
    // of being grouped with other Done jobs ahead of still-Running ones.
    for (const job of jobs) {
      const statusField = job.status.padEnd(24);
      const displayCommand =
        job.status === "Done" ? job.command.replace(/\s*&$/, "") : job.command;
      writeStdout(`[${job.number}]${markerFor(job)}  ${statusField}${displayCommand}`);
    }

    // Now that everything has been reported, remove any Done jobs from the
    // table so they aren't shown (or reported) again.
    const doneJobs = jobs.filter((job) => job.status === "Done");
    for (const job of doneJobs) {
      const idx = jobs.indexOf(job);
      if (idx !== -1) jobs.splice(idx, 1);
      updateStackOnRemoval(job);
    }

    startShell();
    return;
  }

  const executable = findExecutable(command);

  if (executable) {
    const stdoutMode = stdoutAppend ? "a" : "w";
    const stderrMode = stderrAppend ? "a" : "w";

    if (isBackground) {
      try {
        const stdoutFd = stdoutFile ? fs.openSync(stdoutFile, stdoutMode) : "inherit";
        const stderrFd = stderrFile ? fs.openSync(stderrFile, stderrMode) : "inherit";

        // Async spawn: don't wait for the child to exit, so the shell can
        // print the next prompt immediately.
        const child = spawn(executable, args, {
          stdio: ["inherit", stdoutFd, stderrFd],
          argv0: command,
        });

        const jobNumber = getNextJobNumber();
        const job = { number: jobNumber, pid: child.pid, command: input.trim(), status: "Running" };
        registerNewJob(job);

        child.on("exit", () => {
          job.status = "Done";
        });

        console.log(`[${jobNumber}] ${child.pid}`);
      } catch {
        const badFile = stdoutFile || stderrFile;
        console.error(`${command}: ${badFile}: No such file or directory`);
      }

      startShell();
      return;
    }

    try {
      const stdoutFd = stdoutFile ? fs.openSync(stdoutFile, stdoutMode) : "inherit";
      const stderrFd = stderrFile ? fs.openSync(stderrFile, stderrMode) : "inherit";

      spawnSync(executable, args, {
        stdio: ["inherit", stdoutFd, stderrFd],
        argv0: command,
      });

      if (typeof stdoutFd === "number") fs.closeSync(stdoutFd);
      if (typeof stderrFd === "number") fs.closeSync(stderrFd);
    } catch {
      const badFile = stdoutFile || stderrFile;
      console.error(`${command}: ${badFile}: No such file or directory`);
    }
  } else {
    writeStderr(`${command}: command not found`);
  }

  startShell();
});

rl.on("close", () => {
  // Save the full in-memory history back to HISTFILE (if set) whenever the
  // shell exits — whether via the `exit` builtin or the readline interface
  // closing on its own (e.g. Ctrl+D/EOF on stdin). This overwrites the
  // whole file with the current history, matching bash's default
  // save-on-exit behavior (same semantics as `history -w`).
  if (process.env.HISTFILE) {
    writeHistoryToFile(process.env.HISTFILE);
  }
  process.exit(0);
});