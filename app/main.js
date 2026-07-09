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

function completer(line) {
  const lastSpaceIndex = line.lastIndexOf(" ");

  if (lastSpaceIndex === -1) {
    const completableBuiltins = ["echo", "exit"];
    const builtinHits = completableBuiltins.filter((c) => c.startsWith(line));
    const execHits = line.length > 0 ? findExecutableCompletions(line) : new Set();

    const allHits = new Set([...builtinHits, ...execHits]);
    const hits = Array.from(allHits).sort();

    return resolveCompletion(hits, line);
  }

  const prefix = line.slice(lastSpaceIndex + 1);
  const fileHits = Array.from(findFilenameCompletions(prefix)).sort();

  return resolveCompletion(fileHits, prefix);
}