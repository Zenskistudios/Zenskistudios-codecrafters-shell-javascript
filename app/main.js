const readline = require("readline");
const fs = require("fs");
const path = require("path");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

const builtins = ["echo", "exit", "type"];

function startShell() {
  rl.prompt();
}

startShell();

rl.on("line", (command) => {
  if (command === "exit") {
    rl.close();
    return;
  }

  if (command.startsWith("echo ")) {
    console.log(command.slice(5));
    startShell();
    return;
  }

  if (command.startsWith("type ")) {
    const cmd = command.slice(5);

    // Check builtins
    if (builtins.includes(cmd)) {
      console.log(`${cmd} is a shell builtin`);
      startShell();
      return;
    }

    // Search PATH
    const paths = process.env.PATH.split(path.delimiter);

    let found = false;

    for (const dir of paths) {
      const fullPath = path.join(dir, cmd);

      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        console.log(`${cmd} is ${fullPath}`);
        found = true;
        break;
      } catch (err) {
        // Ignore and continue searching
      }
    }

    if (!found) {
      console.log(`${cmd}: not found`);
    }

    startShell();
    return;
  }

  console.log(`${command}: command not found`);
  startShell();
});

rl.on("close", () => {
  process.exit(0);
});