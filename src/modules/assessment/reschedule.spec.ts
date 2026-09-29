import { rescheduleRefusal } from './reschedule';

describe('rescheduleRefusal', () => {
  const now = new Date('2026-09-30T04:00:00Z');
  const from = new Date('2026-10-01T04:00:00Z');
  const to = new Date('2026-10-02T05:30:00Z');
  const base = { status: 'scheduled', evaluationCount: 0, from, to, now };

  it('lets an arranged, unmarked interview move to a later time', () => {
    expect(rescheduleRefusal(base)).toBeNull();
  });

  it('allows moving one that is already overdue, as long as nobody marked', () => {
    expect(
      rescheduleRefusal({ ...base, from: new Date('2026-09-29T04:00:00Z') }),
    ).toBeNull();
  });

  it('sends a no-show to a new booking instead', () => {
    expect(rescheduleRefusal({ ...base, status: 'ABSENT' })).toMatch(/absent/);
  });

  it('refuses a held or cancelled interview', () => {
    expect(rescheduleRefusal({ ...base, status: 'completed' })).toMatch(/held/);
    expect(rescheduleRefusal({ ...base, status: 'cancelled' })).toMatch(/cancelled/);
  });

  it('refuses once anyone has marked the candidate', () => {
    expect(rescheduleRefusal({ ...base, evaluationCount: 2 })).toMatch(
      /2 interviewers have already marked/,
    );
  });

  it('wants a real, future time', () => {
    expect(rescheduleRefusal({ ...base, to: null })).toMatch(/Choose/);
    expect(
      rescheduleRefusal({ ...base, to: new Date('2026-09-30T03:00:00Z') }),
    ).toMatch(/future/);
    expect(rescheduleRefusal({ ...base, to: from })).toMatch(/already booked/);
  });
});
