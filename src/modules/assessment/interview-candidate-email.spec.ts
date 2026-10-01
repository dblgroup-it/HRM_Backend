import { buildCandidateInterviewEmail } from './interview-candidate-email';

describe('candidate interview email', () => {
  it('renders the requested invitation wording and interview details', () => {
    const mail = buildCandidateInterviewEmail({
      candidateName: 'Rahim Uddin',
      designation: 'Senior Executive',
      scheduledAt: new Date('2026-10-04T04:30:00Z'),
      mode: 'PHYSICAL',
      location: 'Head Office :: Room-301',
      meetLink: null,
      recruiter: {
        name: 'Nusrat Jahan',
        phone: '+8801712345678',
        email: 'nusrat@dbl-group.com',
      },
    });

    expect(mail.subject).toBe(
      'Interview Invitation - Senior Executive | DBL Group',
    );
    expect(mail.text).toContain('Dear Rahim Uddin,');
    expect(mail.text).toContain('Greetings from DBL Group.');
    expect(mail.text).toContain(
      'shortlisted for an interview for the position of Senior Executive',
    );
    expect(mail.text).toContain('Position: Senior Executive');
    expect(mail.text).toContain('Date: Sun, 4 Oct 2026');
    expect(mail.text).toContain('Time: 10:30 AM');
    expect(mail.text).toContain('Venue: Room-301');
    expect(mail.text).toContain('Address: Head Office');
    expect(mail.text).toContain('View Location & Directions');
    expect(mail.text).toContain('Nusrat Jahan');
    expect(mail.text).toContain('Contact: +8801712345678');
    expect(mail.text).toContain('Email: nusrat@dbl-group.com');
    expect(mail.html).toContain('Interview Details');
  });

  it('keeps online interviews out of Google Maps', () => {
    const mail = buildCandidateInterviewEmail({
      candidateName: 'Rahim Uddin',
      designation: 'Officer',
      scheduledAt: null,
      mode: 'ONLINE',
      location: null,
      meetLink: 'https://meet.google.com/abc-defg-hij',
    });

    expect(mail.text).toContain('Venue: Online Interview');
    expect(mail.text).toContain('Address: https://meet.google.com/abc-defg-hij');
    expect(mail.text).toContain('Google Maps: Not applicable');
  });
});
