/** Minimal DOM HUD: a fixed set of labelled rows, written only when text changes. */
export class Hud {
  private readonly rows = new Map<string, HTMLElement>();

  constructor(private readonly root: HTMLElement) {}

  set(key: string, label: string, value: string): void {
    let row = this.rows.get(key);
    if (!row) {
      row = document.createElement('div');
      row.className = 'hud-row';
      const l = document.createElement('span');
      l.className = 'hud-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'hud-value';
      row.append(l, v);
      this.root.append(row);
      this.rows.set(key, row);
    }
    const v = row.lastElementChild as HTMLElement;
    if (v.textContent !== value) v.textContent = value;
  }
}
