import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canSee, readManifest } from './tutorial-catalogue';

describe('tutorial catalogue', () => {
  let dir: string;
  const entry = (over: Record<string, unknown> = {}) => ({
    slug: 'raiser',
    number: '01',
    file: 'DBL-HRM-01-Role-Guide-Requisition-Raiser.pdf',
    title: 'Requisition Raiser',
    kicker: 'Role Guide 01',
    subtitle: 's',
    audience: 'a',
    pages: 10,
    bytes: 100,
    roles: ['requisition_raiser'],
    ...over,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorials-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (guides: unknown[]) =>
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ version: '1.1', date: '12 October 2026', guides }),
    );

  it('lists the guides whose PDF is there, in their printed order', () => {
    fs.writeFileSync(path.join(dir, 'a.pdf'), '%PDF');
    fs.writeFileSync(path.join(dir, 'b.pdf'), '%PDF');
    write([
      entry({ slug: 'b', number: '07', file: 'b.pdf' }),
      entry({ slug: 'a', number: '00', file: 'a.pdf' }),
      entry({ slug: 'gone', number: '03', file: 'missing.pdf' }),
    ]);
    const m = readManifest(dir)!;
    expect(m.version).toBe('1.1');
    expect(m.guides.map((g) => g.slug)).toEqual(['a', 'b']);
  });

  it('refuses a file name that is a path', () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'x.pdf'), '%PDF');
    write([entry({ file: '../sub/x.pdf' }), entry({ file: 'sub/x.pdf' })]);
    expect(readManifest(dir)!.guides).toEqual([]);
  });

  it('is null without a manifest, so the page can say so', () => {
    expect(readManifest(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'manifest.json'), 'not json');
    expect(readManifest(dir)).toBeNull();
  });

  it('shows a guide only to holders of its roles — and everything to an administrator', () => {
    expect(canSee({ roles: ['factory_hr'] }, ['factory_hr'], false)).toBe(true);
    expect(canSee({ roles: ['factory_hr'] }, ['chro'], false)).toBe(false);
    expect(
      canSee({ roles: ['unit_approver', 'sbu_head'] }, ['sbu_head'], false),
    ).toBe(true);
    expect(canSee({ roles: ['factory_hr'] }, [], false)).toBe(false);
    expect(canSee({ roles: ['factory_hr'] }, [], true)).toBe(true);
  });

  it('keeps a guide whose thumbnail is missing, without the picture', () => {
    fs.writeFileSync(path.join(dir, 'a.pdf'), '%PDF');
    write([entry({ file: 'a.pdf', thumb: 'a.webp', group: 'Requisition' })]);
    const [g] = readManifest(dir)!.guides;
    expect(g.thumb).toBeUndefined();
    expect(g.group).toBe('Requisition');
    fs.writeFileSync(path.join(dir, 'a.webp'), 'x');
    expect(readManifest(dir)!.guides[0].thumb).toBe('a.webp');
  });
});
