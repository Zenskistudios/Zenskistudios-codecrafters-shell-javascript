const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

function startShell() {
  rl.prompt();
}

startShell();

rl.on("line", (command) => {
  if (command === "exit") {
    rl.close();
  } else if (command.startsWith("echo ")) {
    console.log(command.slice(5));
    startShell();
  } else {
    console.log(`${command}: command not found`);
    startShell();
  }
});

rl.on("close", () => {
  process.exit(0);
});