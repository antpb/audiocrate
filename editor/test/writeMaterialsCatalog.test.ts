import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalog } from '../src/catalog';
import { formatMaterialsCatalog, undocumentedKinds } from '../src/materialsCatalog';

const here = dirname(fileURLToPath(import.meta.url));

describe('materials catalog', () => {
  it('documents every palette kind and writes the markdown', () => {
    expect(undocumentedKinds(), 'add a MATERIAL_NOTES sentence for each new kind').toEqual([]);
    const markdown = formatMaterialsCatalog();
    const out = resolve(here, '../docs/materials.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, markdown);
    for (const entry of catalog.filter((item) => !item.kind.startsWith('user.'))) {
      expect(markdown, entry.kind).toContain(`(\`${entry.kind}\`)`);
    }
    expect(markdown).toContain('| Param |');
    expect(markdown).toContain('sampleplayer');
    expect(markdown).toContain('ParametricEQ');
  });
});
