import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TutorialsService } from './tutorials.service';

/**
 * The Tutorials menu is role-based: a person sees the guides for the roles
 * they hold, and only those are given a link. Super users and the platform
 * administrator see every guide.
 */
describe('TutorialsService: who sees which guide', () => {
  let dir: string;
  const guide = (slug: string, number: string, roles: string[]) => ({
    slug,
    number,
    file: `${slug}.pdf`,
    title: slug,
    kicker: 'Role Guide',
    subtitle: '',
    audience: '',
    pages: 1,
    bytes: 1,
    roles,
    group: 'Requisition',
    contents: ['Your role at a glance'],
  });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorials-svc-'));
    const guides = [
      guide('master', '00', ['chro', 'corporate_hr']),
      guide('factory-hr', '02', ['factory_hr']),
      guide('approver', '03', ['unit_approver', 'sbu_head']),
      guide('hota', '04', ['corporate_hr']),
      guide('panelist', '09', ['interviewer']),
      guide('admin', '12', ['super_user', 'admin']),
    ];
    for (const g of guides) fs.writeFileSync(path.join(dir, g.file), '%PDF');
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ version: '1.1', date: '12 October 2026', guides }),
    );
    process.env.TUTORIALS_DIR = dir;
  });
  afterAll(() => {
    delete process.env.TUTORIALS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const PLAYLIST = {
    playlistId: 'PLMh1t_lzQ2ZM',
    title: 'TalentHub Web Application Configuration',
    channel: 'DBL GROUP IT Helpdesk',
  };

  function build(
    roles: { key: string; name: string }[],
    isSuperUser = false,
    video: {
      playlistId: string | null;
      title: string;
      channel: string;
    } = PLAYLIST,
  ) {
    const mint = jest.fn((slug: string) => `grant-${slug}`);
    const svc = new TutorialsService(
      {
        getUserPermissions: jest
          .fn()
          .mockResolvedValue({ isSuperUser, roles, unitIds: [] }),
      } as never,
      { mint } as never,
      { getTutorialVideoConfig: jest.fn().mockResolvedValue(video) } as never,
    );
    return { svc, mint };
  }

  it('gives Factory HR the Factory HR guide and nothing else', async () => {
    const { svc, mint } = build([{ key: 'factory_hr', name: 'Factory HR' }]);
    const list = await svc.list({ id: 'u', role: 'EMPLOYEE' });
    expect(list.scope).toBe('roles');
    expect(list.roles).toEqual([{ key: 'factory_hr', name: 'Factory HR' }]);
    expect(list.guides.map((g) => g.slug)).toEqual(['factory-hr']);
    // Links are signed only for what this person may open.
    expect(mint.mock.calls.map((c) => c[0])).toEqual(['factory-hr']);
  });

  it('gives someone with several roles a guide for each', async () => {
    const { svc } = build([
      { key: 'factory_hr', name: 'Factory HR' },
      { key: 'factory_hr', name: 'Factory HR' },
      { key: 'interviewer', name: 'Interviewer' },
    ]);
    const list = await svc.list({ id: 'u', role: 'EMPLOYEE' });
    expect(list.guides.map((g) => g.slug)).toEqual(['factory-hr', 'panelist']);
    expect(list.roles).toHaveLength(2);
  });

  it('gives Head of Talent Acquisition the master document and their own guide', async () => {
    const { svc } = build([
      { key: 'corporate_hr', name: 'Head of Talent Acquisition' },
    ]);
    const list = await svc.list({ id: 'u', role: 'EMPLOYEE' });
    expect(list.guides.map((g) => g.slug)).toEqual(['master', 'hota']);
  });

  it('gives a super user and the admin login every guide', async () => {
    const su = await build(
      [{ key: 'super_user', name: 'Super User' }],
      true,
    ).svc.list({
      id: 'u',
      role: 'EMPLOYEE',
    });
    expect(su.scope).toBe('all');
    expect(su.guides).toHaveLength(6);
    const admin = await build([], true).svc.list({ id: 'u', role: 'ADMIN' });
    expect(admin.guides).toHaveLength(6);
    expect(admin.roles).toEqual([{ key: 'admin', name: 'Administrator' }]);
  });

  it('gives somebody whose roles have no guide an empty list', async () => {
    const list = await build([
      { key: 'some_custom_role', name: 'Plant Manager' },
    ]).svc.list({
      id: 'u',
      role: 'EMPLOYEE',
    });
    expect(list.guides).toEqual([]);
  });

  it('gives everyone the video playlist, whatever their roles', async () => {
    for (const roles of [
      [{ key: 'factory_hr', name: 'Factory HR' }],
      [{ key: 'some_custom_role', name: 'Plant Manager' }],
    ]) {
      const list = await build(roles).svc.list({ id: 'u', role: 'EMPLOYEE' });
      expect(list.videos).toEqual({
        playlistId: 'PLMh1t_lzQ2ZM',
        title: 'TalentHub Web Application Configuration',
        channel: 'DBL GROUP IT Helpdesk',
        url: 'https://www.youtube.com/playlist?list=PLMh1t_lzQ2ZM',
        embedUrl:
          'https://www.youtube-nocookie.com/embed/videoseries?list=PLMh1t_lzQ2ZM',
      });
    }
  });

  it('shows no videos once the playlist is taken off the page', async () => {
    const list = await build(
      [{ key: 'factory_hr', name: 'Factory HR' }],
      false,
      {
        ...PLAYLIST,
        playlistId: null,
      },
    ).svc.list({ id: 'u', role: 'EMPLOYEE' });
    expect(list.videos).toBeNull();
  });
});
