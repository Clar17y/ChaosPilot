/** Pure presentation helpers for run-detail tabs and experiment selection. */

/** Index to activate for a tablist key, or null when the key is not a tab-navigation key. Wraps at both ends. */
export function tabIndexForKey(currentIndex: number, key: string, tabCount: number): number | null {
  if (tabCount <= 0) return null;
  const current = Math.min(Math.max(currentIndex, 0), tabCount - 1);
  switch (key) {
    case 'ArrowRight': return (current + 1) % tabCount;
    case 'ArrowLeft': return (current - 1 + tabCount) % tabCount;
    case 'Home': return 0;
    case 'End': return tabCount - 1;
    default: return null;
  }
}

/** Keeps a selection valid after a record refresh adds/removes experiments. */
export function clampSelectedIndex(selected: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(selected) || selected < 0) return 0;
  return Math.min(Math.floor(selected), count - 1);
}
