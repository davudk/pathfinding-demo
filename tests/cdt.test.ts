import { describe, expect, it } from 'vitest';
import { DynamicCDT, NONE, next, CdtError } from '../src/sim/nav/cdt';
import { Rng } from '../src/shared/rng';

const W = 64, H = 64;

function corners(): DynamicCDT {
  const xs = new Float64Array([0, W, W, 0]);
  const ys = new Float64Array([0, 0, H, H]);
  return DynamicCDT.fromPoints(W, H, xs, ys, new Uint8Array([1, 1, 1, 1]));
}

function expectValid(cdt: DynamicCDT, label: string): void {
  const errs = cdt.validate();
  expect(errs, label).toEqual([]);
}

/** Rectangle corners on the half-unit lattice, inside the map with a 1-unit margin. */
function randomRect(rng: Rng): [number, number, number, number] {
  const w = 1 + rng.int(8) * 0.5, h = 1 + rng.int(8) * 0.5;
  const x = 1 + rng.int((W - 2 - w) * 2) * 0.5, y = 1 + rng.int((H - 2 - h) * 2) * 0.5;
  return [x, y, x + w, y + h];
}

function rectsOverlap(a: number[], b: number[]): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function addRect(cdt: DynamicCDT, r: number[]): number[] {
  const [x0, y0, x1, y1] = r;
  const v = [cdt.insertVertex(x0, y0), cdt.insertVertex(x1, y0), cdt.insertVertex(x1, y1), cdt.insertVertex(x0, y1)];
  for (let k = 0; k < 4; k++) cdt.insertConstraint(v[k], v[(k + 1) % 4]);
  return v;
}

function removeRect(cdt: DynamicCDT, r: number[]): void {
  const [x0, y0, x1, y1] = r;
  const v = [cdt.vertexAt(x0, y0), cdt.vertexAt(x1, y0), cdt.vertexAt(x1, y1), cdt.vertexAt(x0, y1)];
  const chainVerts = new Set<number>();
  for (let k = 0; k < 4; k++) for (const c of cdt.removeConstraint(v[k], v[(k + 1) % 4])) chainVerts.add(c);
  for (const c of chainVerts) {
    if (!cdt.hasConstraint(c) && !(cdt.vFlags[c] & 1)) cdt.removeVertex(c);
  }
}

describe('DynamicCDT', () => {
  it('bootstraps a valid triangulation from Delaunator', () => {
    const rng = new Rng(3);
    const n = 300;
    const xs = new Float64Array(n + 4), ys = new Float64Array(n + 4);
    xs.set([0, W, W, 0]);
    ys.set([0, 0, H, H]);
    for (let i = 4; i < n + 4; i++) {
      xs[i] = 1 + rng.int((W - 2) * 16) / 16;
      ys[i] = 1 + rng.int((H - 2) * 16) / 16;
    }
    // Deduplicate.
    const seen = new Set<string>();
    const keep: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const k = `${xs[i]},${ys[i]}`;
      if (!seen.has(k)) {
        seen.add(k);
        keep.push(i);
      }
    }
    const cdt = DynamicCDT.fromPoints(W, H, Float64Array.from(keep, (i) => xs[i]), Float64Array.from(keep, (i) => ys[i]), new Uint8Array(keep.length));
    expectValid(cdt, 'bootstrap');
  });

  it('inserts vertices inside triangles, on edges and on the hull', () => {
    const cdt = corners();
    cdt.insertVertex(32, 32);
    cdt.insertVertex(16, 16); // on the diagonal edge from the first split
    cdt.insertVertex(32, 0); // on the hull
    cdt.insertVertex(0, 10);
    expectValid(cdt, 'vertices');
    expect(cdt.liveVertices()).toBe(8);
  });

  it('locates points and reports edges', () => {
    const cdt = corners();
    const t = cdt.locate(10, 50);
    expect(t).not.toBe(NONE);
    expect(cdt.locate(-1, 5)).toBe(NONE);
  });

  it('recovers constraints with collinear vertices on them', () => {
    const cdt = corners();
    const a = cdt.insertVertex(4, 30), m = cdt.insertVertex(30, 30), b = cdt.insertVertex(60, 30);
    for (let i = 0; i < 40; i++) cdt.insertVertex(5 + ((i * 37) % 54), 5 + ((i * 53) % 54) + 0.25);
    cdt.insertConstraint(a, b);
    expectValid(cdt, 'after constraint');
    expect(cdt.cRef[cdt.findEdge(a, m)]).toBe(1);
    expect(cdt.cRef[cdt.findEdge(m, b)]).toBe(1);
    expect(cdt.findEdge(a, b)).toBe(NONE);
  });

  it('refuses constraints that cross existing ones', () => {
    const cdt = corners();
    cdt.insertConstraint(cdt.insertVertex(10, 32), cdt.insertVertex(50, 32));
    const p = cdt.insertVertex(30, 10), q = cdt.insertVertex(30, 50);
    expect(() => cdt.insertConstraint(p, q)).toThrow(CdtError);
  });

  it('fuzz: random rectangle obstacles added and removed keep a valid CDT', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = new Rng(seed);
      const cdt = corners();
      const live: number[][] = [];
      for (let op = 0; op < 200; op++) {
        if (live.length > 0 && rng.float() < 0.4) {
          const k = rng.int(live.length);
          removeRect(cdt, live[k]);
          live.splice(k, 1);
          expectValid(cdt, `seed ${seed} op ${op} remove`);
        } else {
          const r = randomRect(rng);
          // Touching is allowed (shared/collinear edges); overlap is not.
          if (live.some((o) => rectsOverlap(o, r))) continue;
          addRect(cdt, r);
          live.push(r);
          expectValid(cdt, `seed ${seed} op ${op} add`);
        }
      }
      // Remove everything: back to a mesh with no constraints and only the fixed corners.
      for (const r of live) removeRect(cdt, r);
      expectValid(cdt, `seed ${seed} cleared`);
      let constrained = 0;
      for (let e = 0; e < cdt.tCount * 3; e++) if (cdt.cRef[e] > 0) constrained++;
      expect(constrained, `seed ${seed} leftover constraints`).toBe(0);
      expect(cdt.liveVertices(), `seed ${seed} leftover vertices`).toBe(4);
    }
  });

  it('reference-counts shared edges of touching rectangles', () => {
    const cdt = corners();
    const left = [10, 10, 20, 20], right = [20, 10, 30, 20];
    addRect(cdt, left);
    addRect(cdt, right);
    const a = cdt.vertexAt(20, 10), b = cdt.vertexAt(20, 20);
    const e = cdt.findEdge(a, b);
    expect(cdt.cRef[e]).toBe(2);
    removeRect(cdt, left);
    expect(cdt.cRef[cdt.findEdge(a, b)]).toBe(1);
    expect(cdt.vertexAt(10, 10)).toBe(NONE);
    expectValid(cdt, 'after removing one');
    void next;
  });
});
