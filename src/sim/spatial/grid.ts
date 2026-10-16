/**
 * Uniform grid over unit positions, rebuilt from scratch every tick with a counting sort
 * (O(n + cells), allocation-free). Units are bucketed by center; queries widen their range
 * by the largest unit radius, so big units need no special handling.
 */
export class UnitGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellStart: Int32Array;
  readonly items: Int32Array;
  private readonly cellOf: Int32Array;
  private readonly cursor: Int32Array;
  count = 0;

  constructor(readonly width: number, readonly height: number, readonly cell: number, capacity: number) {
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(height / cell);
    const cells = this.cols * this.rows;
    this.cellStart = new Int32Array(cells + 1);
    this.cursor = new Int32Array(cells);
    this.items = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
  }

  cellIndex(x: number, y: number): number {
    let cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  /** Rebuilds from the given slots and positions. */
  build(active: Int32Array, n: number, xs: Float64Array, ys: Float64Array): void {
    const { cellStart, cursor, items, cellOf } = this;
    cellStart.fill(0);
    for (let k = 0; k < n; k++) {
      const i = active[k];
      const c = this.cellIndex(xs[i], ys[i]);
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < cursor.length; c++) cellStart[c + 1] += cellStart[c];
    cursor.set(cellStart.subarray(0, cursor.length));
    // Insert in active order so query results are deterministic.
    for (let k = 0; k < n; k++) {
      const i = active[k];
      items[cursor[cellOf[i]]++] = i;
    }
    this.count = n;
  }

  /** Cell range covering the square [x−R, x+R] × [y−R, y+R]; written to out[0..3]. */
  range(x: number, y: number, R: number, out: Int32Array): void {
    const c = this.cell;
    out[0] = Math.max(0, Math.floor((x - R) / c));
    out[1] = Math.max(0, Math.floor((y - R) / c));
    out[2] = Math.min(this.cols - 1, Math.floor((x + R) / c));
    out[3] = Math.min(this.rows - 1, Math.floor((y + R) / c));
  }
}
