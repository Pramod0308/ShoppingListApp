// Applies a plain-string edit — the whole current value of an <input> — to a Y.Text
// as an insert/delete of just the run that actually changed.
//
// The naive alternative is to store the string as a plain field and overwrite it on
// every edit. That makes the last writer win over the whole value, so two people
// editing the same row lose one of the two edits outright. Narrowing the write to
// the characters that moved is what lets Yjs merge them.

/// `transact` is the host document's `transact`, so the delete and the insert land
/// as one atomic change rather than as two observable steps.
export function applyTextEdit(transact, ytext, next) {
  const prev = ytext.toString();
  if (prev === next) return false;

  // Longest common prefix.
  let start = 0;
  const shortest = Math.min(prev.length, next.length);
  while (start < shortest && prev[start] === next[start]) start++;

  // Longest common suffix that does not overlap the prefix.
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }

  transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  });
  return true;
}
