import { facilitiesConflict } from './facilities';

const at = new Date('2026-09-27T05:30:00Z'); // 11:30 in Dhaka

describe('facilitiesConflict', () => {
  it('lets a save through when nobody saved since the form was opened', () => {
    expect(facilitiesConflict(at.toISOString(), { at, byName: 'A', byId: 'a' }, 'b')).toBeNull();
    expect(facilitiesConflict(null, { at: null, byName: null, byId: null }, 'b')).toBeNull();
  });

  it('refuses a save over a colleague’s newer one, naming them', () => {
    const msg = facilitiesConflict(null, { at, byName: 'Omar Faruque', byId: 'a' }, 'b');
    expect(msg).toMatch(/Omar Faruque saved these facilities at 11:30/);
  });

  it('does not block someone editing their own last save', () => {
    expect(facilitiesConflict(null, { at, byName: 'B', byId: 'b' }, 'b')).toBeNull();
  });

  it('skips the check for a screen that does not send a stamp', () => {
    expect(facilitiesConflict(undefined, { at, byName: 'A', byId: 'a' }, 'b')).toBeNull();
  });
});
