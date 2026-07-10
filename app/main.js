const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const builtins = ["echo", "exit", "type", "pwd", "cd", "complete", "jobs"];

// Registered completion specs from `complete -C <script> <command>`,
// keyed by command name -> completer script path.
const completionSpecs = new Map();

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

function startShell() {
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

startShell();

rl.on("line", (input) => {
  const rawParts = parseInput(input);

  if (rawParts.length === 0) {
    startShell();
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

  if (command === "jobs") {
    // Empty implementation for this stage: no background jobs are tracked
    // yet, so there's nothing to list.
    startShell();
    return;
  }

  const executable = findExecutable(command);

  if (executable) {
    try {
      const stdoutMode = stdoutAppend ? "a" : "w";
      const stderrMode = stderrAppend ? "a" : "w";
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
  process.exit(0);
});