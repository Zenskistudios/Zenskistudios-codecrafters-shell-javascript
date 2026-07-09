// Find files in the current directory whose name starts with the given prefix.
function findFilenameCompletions(prefix) {
  const matches = new Set();
  let entries;
  try {
    entries = fs.readdirSync(".");
  } catch {
    return matches;
  }

  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      matches.add(entry);
    }
  }

  return matches;
}

// Shared logic for turning a set of candidate hits into a readline completion
// result, given the text that should be replaced (either the whole line, when
// completing a command name, or just the last word, when completing a
// filename argument).
function resolveCompletion(hits, matchText) {
  if (hits.length === 1) {
    lastAmbiguousLine = null;
    return [[hits[0] + " "], matchText];
  }

  if (hits.length === 0) {
    lastAmbiguousLine = null;
    process.stdout.write("\x07");
    return [[], matchText];
  }

  const lcp = longestCommonPrefix(hits);

  if (lcp.length > matchText.length) {
    lastAmbiguousLine = null;
    return [[lcp], matchText];
  }

  if (lastAmbiguousLine !== matchText) {
    lastAmbiguousLine = matchText;
    process.stdout.write("\x07");
    return [[], matchText];
  }

  process.stdout.write("\n" + hits.join("  ") + "\n");
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
  const fileHits = Array.from(findFilenameCompletions(prefix)).sort();

  return resolveCompletion(fileHits, prefix);
}