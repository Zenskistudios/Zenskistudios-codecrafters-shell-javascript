const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

function prompt() {
  rl.prompt();
}

prompt();

rl.on("line", (line) => {
  console.log(`${line}: command not found`);
  prompt();
});