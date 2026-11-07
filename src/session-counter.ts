import { VIEW_TYPE_APP } from "./webview-view";

/** The part of a workspace leaf the count reads. A leaf whose view has not loaded yet still answers `getViewState()`. */
export interface SessionLeaf {
  getViewState(): { type?: string; state?: unknown };
}

/** The slug in a saved App Runner view state, or null when the leaf is another view type or has no slug. */
export function sessionSlug(leaf: SessionLeaf): string | null {
  let saved: { type?: string; state?: unknown } | undefined;
  try {
    saved = leaf.getViewState();
  } catch {
    return null;
  }
  if (saved?.type !== VIEW_TYPE_APP) return null;
  const slug = (saved.state as { slug?: unknown } | null | undefined)?.slug;
  return typeof slug === "string" && slug !== "" ? slug : null;
}

/** How many App Runner tabs each project has: one per leaf, counted from its saved view state. */
export function countSessions(leaves: readonly SessionLeaf[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const leaf of leaves) {
    const slug = sessionSlug(leaf);
    if (slug !== null) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return counts;
}

/**
 * G14: the number of open Obsidian tabs per project (a Session), loaded or not. The count is taken from the leaves'
 * saved view state, not from live views, so a tab restored at layout restore but never made visible still counts (G11).
 *
 * `refresh()` re-reads the leaves; it is called on every layout change, so a drag between panes or into a pop-out window
 * (detach, then attach) simply dips to zero and back. Listeners hear about each project whose count changed.
 */
export class SessionCounter {
  private counts = new Map<string, number>();
  private readonly listeners = new Set<(slug: string) => void>();

  constructor(private readonly leaves: () => readonly SessionLeaf[]) {}

  count(slug: string): number {
    return this.counts.get(slug) ?? 0;
  }

  /** Re-read the workspace; tell listeners about every project whose count changed. */
  refresh(): void {
    const next = countSessions(this.leaves());
    const changed = new Set<string>();
    for (const [slug, n] of next) if (this.count(slug) !== n) changed.add(slug);
    for (const slug of this.counts.keys()) if (!next.has(slug)) changed.add(slug);
    this.counts = next;
    for (const slug of changed) this.emit(slug);
  }

  subscribe(listener: (slug: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Plugin unload: forget every listener. */
  clearListeners(): void {
    this.listeners.clear();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private emit(slug: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(slug);
      } catch {
        // One listener's failure must not stop the others hearing the change.
      }
    }
  }
}
