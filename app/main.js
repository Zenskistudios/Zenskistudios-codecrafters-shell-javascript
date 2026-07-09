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

    if (char === "'") {
      inSingleQuote = true;
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

startShell();

rl.on("line", (input) => {
  const parts = parseInput(input);

  if (parts.length === 0) {
    startShell();
    return;
  }

  const command = parts[0];
  const args = parts.slice(1);

  if (command === "exit") {
    rl.close();
    return;
  }

  if (command === "echo") {
    console.log(args.join(" "));
    startShell();
    return;
  }

  if (command === "pwd") {
    console.log(process.cwd());
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

    if (builtins.includes(cmd)) {
      console.log(`${cmd} is a shell builtin`);
    } else {
      const executable = findExecutable(cmd);

      if (executable) {
        console.log(`${cmd} is ${executable}`);
      } else {
        console.log(`${cmd}: not found`);
      }
    }

    startShell();
    return;
  }

  const executable = findExecutable(command);

  if (executable) {
    spawnSync(executable, args, {
      stdio: "inherit",
      argv0: command,
    });
  } else {
    console.log(`${command}: command not found`);
  }

  startShell();
});

rl.on("close", () => {
  process.exit(0);
});