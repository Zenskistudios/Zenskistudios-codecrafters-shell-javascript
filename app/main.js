const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

const builtins = ["echo", "exit", "type"];

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

startShell();

rl.on("line", (input) => {
  const parts = input.trim().split(/\s+/);
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
    });
  } else {
    console.log(`${command}: command not found`);
  }

  startShell();
});

rl.on("close", () => {
  process.exit(0);
});