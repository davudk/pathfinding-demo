/**
 * SC2 control groups: Ctrl+N assigns, Shift+N adds, N recalls, N twice quickly centers the camera.
 * Groups hold handles; dead units are filtered out against snapshots on recall.
 */
export class ControlGroups {
  readonly groups: (number[] | null)[] = new Array<number[] | null>(10).fill(null);
  private lastRecall = -1;
  private lastRecallAt = 0;
  version = 0;

  assign(n: number, handles: Iterable<number>): void {
    const list = [...handles];
    this.groups[n] = list.length ? list : null;
    this.version++;
  }

  add(n: number, handles: Iterable<number>): void {
    const set = new Set(this.groups[n] ?? []);
    for (const h of handles) set.add(h);
    this.groups[n] = set.size ? [...set] : null;
    this.version++;
  }

  /** Returns the group's handles and whether this was a double-tap. */
  recall(n: number, now: number): { handles: number[]; double: boolean } {
    const double = this.lastRecall === n && now - this.lastRecallAt < 350;
    this.lastRecall = n;
    this.lastRecallAt = now;
    return { handles: this.groups[n] ?? [], double };
  }

  /** Drops handles that no longer pass `alive` (called occasionally). */
  prune(alive: (h: number) => boolean): void {
    let changed = false;
    for (let n = 0; n < this.groups.length; n++) {
      const g = this.groups[n];
      if (!g) continue;
      const kept = g.filter(alive);
      if (kept.length !== g.length) {
        this.groups[n] = kept.length ? kept : null;
        changed = true;
      }
    }
    if (changed) this.version++;
  }
}
