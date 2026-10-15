import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

/** Top-level src/ area a resolved import lands in. */
function area(file: string, spec: string): string {
  if (!spec.startsWith('.')) return `pkg:${spec}`;
  return relative(SRC, resolve(dirname(file), spec)).split(/[\\/]/)[0];
}

describe('module boundaries', () => {
  it('sim/ imports only sim/ and shared/', () => {
    for (const f of files(join(SRC, 'sim'))) {
      for (const spec of imports(f)) {
        const a = area(f, spec);
        expect(['sim', 'shared'], `${relative(SRC, f)} imports ${spec}`).toContain(a);
      }
    }
  });

  it('shared/ imports only shared/', () => {
    for (const f of files(join(SRC, 'shared'))) {
      for (const spec of imports(f)) expect(area(f, spec), `${relative(SRC, f)} imports ${spec}`).toBe('shared');
    }
  });

  it('render/, input/, ui/ never import sim/', () => {
    for (const dir of ['render', 'input', 'ui', 'debug']) {
      for (const f of files(join(SRC, dir))) {
        for (const spec of imports(f)) expect(area(f, spec), `${relative(SRC, f)} imports ${spec}`).not.toBe('sim');
      }
    }
  });
});
