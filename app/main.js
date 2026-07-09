const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const builtins = ["echo", "exit", "type", "pwd", "cd"];

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

// Tracks state between consecutive Tab presses on the same (unchanged) line,
// so we know whether this is the first ambiguous press (ring bell) or a
// repeat press (let readline's built-in behavior list the candidates).
let lastAmbiguousLine = null;

// Tab-completion: builtins (echo, exit) plus any matching executables in PATH.
function completer(line) {
  const completableBuiltins = ["echo", "exit"];
  const builtinHits = completableBuiltins.filter((c) => c.startsWith(line));

  const execHits = line.length > 0 ? findExecutableCompletions(line) : new Set();

  const allHits = new Set([...builtinHits, ...execHits]);
  const hits = Array.from(allHits).sort();

  if (hits.length === 1) {
    lastAmbiguousLine = null;
    return [[hits[0] + " "], line];
  }

  if (hits.length === 0) {
    lastAmbiguousLine = null;
    // No matches: leave input unchanged, ring the terminal bell.
    process.stdout.write("\x07");
    return [[], line];
  }

  // Multiple matches (ambiguous).
  if (lastAmbiguousLine !== line) {
    // First Tab press for this line: ring the bell, don't list yet.
    lastAmbiguousLine = line;
    process.stdout.write("\x07");
    return [[], line];
  }

  // Second (or later) Tab press for the same line: let readline's
  // built-in behavior print the sorted candidate list and redraw the
  // prompt with the original prefix preserved.
  return [hits, line];
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