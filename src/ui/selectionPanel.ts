import { ARCHETYPES } from '../shared/archetypes';
import { FACTION_COLORS, FACTION_NAMES } from '../shared/factions';
import { I_ATTRS, I_HANDLE, INST_WORDS, SNAP_HEADER_WORDS, attrArchetype, attrFaction, type SnapshotViews } from '../shared/protocol';
import type { ControlGroups } from '../input/controlGroups';

/** Bottom-center panel: selection summary by unit type, and the control-group bar. */
export class SelectionPanel {
  private lastKey = '';
  private lastGroups = -1;

  constructor(private readonly summary: HTMLElement, private readonly bar: HTMLElement) {}

  update(s: SnapshotViews | null, handles: ReadonlySet<number>, groups: ControlGroups): void {
    if (s) this.updateSummary(s, handles);
    if (groups.version !== this.lastGroups) {
      this.lastGroups = groups.version;
      this.bar.replaceChildren(
        ...groups.groups.map((g, n) => {
          if (n === 0 || !g) return null;
          const el = document.createElement('div');
          el.className = 'cg';
          el.innerHTML = `<span class="cg-key">${n}</span><span class="cg-count">${g.length}</span>`;
          return el;
        }).filter((x): x is HTMLDivElement => x !== null),
      );
    }
  }

  private updateSummary(s: SnapshotViews, handles: ReadonlySet<number>): void {
    // Count live selected units per (faction, archetype).
    const counts = new Map<number, number>();
    for (const h of handles) {
      const o = SNAP_HEADER_WORDS + (h & 0xffff) * INST_WORDS;
      if (s.u32[o + I_HANDLE] !== h) continue;
      const a = s.u32[o + I_ATTRS];
      const key = attrFaction(a) * 16 + attrArchetype(a);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => ARCHETYPES[b[0] & 15].radius - ARCHETYPES[a[0] & 15].radius || b[1] - a[1]);
    const key = sorted.map(([k, n]) => `${k}:${n}`).join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.summary.classList.toggle('hidden', sorted.length === 0);
    this.summary.replaceChildren(
      ...sorted.map(([k, n]) => {
        const fac = k >> 4, arch = k & 15;
        const [r, g, b] = FACTION_COLORS[fac] ?? FACTION_COLORS[4];
        const el = document.createElement('div');
        el.className = 'sel-item';
        el.title = `${FACTION_NAMES[fac]} ${ARCHETYPES[arch].name}`;
        const size = 8 + ARCHETYPES[arch].radius * 8;
        el.innerHTML = `<span class="sel-dot" style="width:${size}px;height:${size}px;background:rgb(${r * 255},${g * 255},${b * 255})"></span><span class="sel-name">${ARCHETYPES[arch].name}</span><span class="sel-count">×${n}</span>`;
        return el;
      }),
    );
  }
}
