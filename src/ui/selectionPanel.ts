import { ARCHETYPES } from '../shared/archetypes';
import { FACTION_COLORS, FACTION_NAMES } from '../shared/factions';
import { I_ATTRS, I_HANDLE, INST_WORDS, SNAP_HEADER_WORDS, attrArchetype, attrFaction, type SnapshotViews } from '../shared/protocol';
import type { ControlGroups } from '../input/controlGroups';

const LONG_PRESS_MS = 450;

export interface GroupActions {
  recall(n: number): void;
  assign(n: number): void;
  /** Assigns the selection to the first empty group. */
  assignNew(): void;
}

/**
 * Bottom-center panel: selection summary by unit type, and the control-group bar. Group chips
 * are buttons: click/tap recalls (twice centers), long press reassigns; the "+" chip (touch
 * only) puts the selection into a new group.
 */
export class SelectionPanel {
  private lastKey = '';
  private palette: readonly (readonly [number, number, number])[] = FACTION_COLORS;

  setPalette(colors: readonly (readonly [number, number, number])[]): void {
    this.palette = colors;
    this.lastKey = ''; // force a redraw
  }
  private lastGroups = -1;

  constructor(private readonly summary: HTMLElement, private readonly bar: HTMLElement, actions?: GroupActions) {
    if (actions) this.wireGroups(actions);
  }

  private wireGroups(actions: GroupActions): void {
    let timer = 0;
    let pressed: HTMLElement | null = null;
    this.bar.addEventListener('pointerdown', (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>('.cg');
      if (!chip || e.button !== 0) return;
      e.preventDefault();
      pressed = chip;
      clearTimeout(timer);
      const n = Number(chip.dataset.group);
      if (n > 0) {
        timer = window.setTimeout(() => {
          if (pressed !== chip) return;
          pressed = null;
          navigator.vibrate?.(8);
          actions.assign(n);
        }, LONG_PRESS_MS);
      }
    });
    const release = (e: PointerEvent): void => {
      const chip = pressed;
      pressed = null;
      clearTimeout(timer);
      if (!chip || e.type === 'pointercancel' || !chip.contains(e.target as Node)) return;
      const n = Number(chip.dataset.group);
      if (n > 0) actions.recall(n);
      else actions.assignNew();
    };
    this.bar.addEventListener('pointerup', release);
    this.bar.addEventListener('pointercancel', release);
    this.bar.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  update(s: SnapshotViews | null, handles: ReadonlySet<number>, groups: ControlGroups): void {
    if (s) this.updateSummary(s, handles);
    if (groups.version !== this.lastGroups) {
      this.lastGroups = groups.version;
      this.bar.replaceChildren(
        ...groups.groups.map((g, n) => {
          if (n === 0 || !g) return null;
          const el = document.createElement('button');
          el.className = 'cg';
          el.dataset.group = String(n);
          el.title = `Control group ${n}: click to select (twice: center) · hold to reassign`;
          el.innerHTML = `<span class="cg-key">${n}</span><span class="cg-count">${g.length}</span>`;
          return el;
        }).filter((x): x is HTMLButtonElement => x !== null),
        this.newGroupChip(),
      );
    }
  }

  private newGroupChip(): HTMLElement {
    const el = document.createElement('button');
    el.className = 'cg cg-new touch-only';
    el.dataset.group = '0';
    el.title = 'Put the selection into a new control group';
    el.textContent = '+ group';
    return el;
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
        const [r, g, b] = this.palette[fac] ?? this.palette[4];
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
