const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

const builtins = ["echo", "exit", "type", "pwd", "cd"];

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

// Scans tokens for '>' or '1>' redirection and strips them out.
// Returns { args, stdoutFile }.
function extractRedirection(parts) {
  const args = [];
  let stdoutFile = null;

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];

    if (token === ">" || token === "1>") {
      stdoutFile = parts[i + 1];
      i++; // skip the filename token
    } else {
      args.push(token);
    }
  }

  return { args, stdoutFile };
}

startShell();

rl.on("line", (input) => {
  const rawParts = parseInput(input);

  if (rawParts.length === 0) {
    startShell();
    return;
  }

  const { args: parts, stdoutFile } = extractRedirection(rawParts);

  if (parts.length === 0) {
    startShell();
    return;
  }

  const command = parts[0];
  const args = parts.slice(1);

  // Helper: write a line either to the redirected file or to stdout.
  function writeOutput(text) {
    if (stdoutFile) {
      fs.appendFileSync(stdoutFile, text + "\n");
    } else {
      console.log(text);
    }
  }

  if (command === "exit") {
    rl.close();
    return;
  }

  if (command === "echo") {
    if (stdoutFile) {
      // Create/truncate the file first, then write.
      fs.writeFileSync(stdoutFile, args.join(" ") + "\n");
    } else {
      console.log(args.join(" "));
    }
    startShell();
    return;
  }

  if (command === "pwd") {
    writeOutput(process.cwd());
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
      console.log(`cd: ${args[0]}: No such file or directory`);
    }

    startShell();
    return;
  }

  if (command === "type") {
    const cmd = args[0];
    let output;

    if (builtins.includes(cmd)) {
      output = `${cmd} is a shell builtin`;
    } else {
      const executable = findExecutable(cmd);
      output = executable ? `${cmd} is ${executable}` : `${cmd}: not found`;
    }

    writeOutput(output);
    startShell();
    return;
  }

  const executable = findExecutable(command);

  if (executable) {
    let stdoutFd = "inherit";

    if (stdoutFile) {
      stdoutFd = fs.openSync(stdoutFile, "w");
    }

    spawnSync(executable, args, {
      stdio: ["inherit", stdoutFd, "inherit"],
      argv0: command,
    });

    if (typeof stdoutFd === "number") {
      fs.closeSync(stdoutFd);
    }
  } else {
    console.log(`${command}: command not found`);
  }

  startShell();
});

rl.on("close", () => {
  process.exit(0);
});