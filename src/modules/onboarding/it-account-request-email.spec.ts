import {
  defaultItPurpose,
  itRequestSubject,
  renderItCompletion,
  renderItRequest,
  type ItRequestMail,
} from './it-account-request-email';

/**
 * "Notify IT" writes the email IT already receives by hand. The expected text
 * below is DBL's own example request, so a change that drifts from that
 * format fails here rather than in somebody's inbox.
 */
const glory: ItRequestMail = {
  salutation: 'Farhad bhai',
  unit: 'Glory Textile & Apparels Ltd.',
  lineOfBusiness: 'RMG Division',
  employeeName: 'Sudansha Kirtonia',
  preferredEmail: 'quality.accesories@glory-dbl.com',
  platform: 'Google',
  purpose:
    'This account will be used to communicate with buyers, buying houses, suppliers and the marketing team.',
  deletions: [
    {
      name: 'Md. Rasel Rana',
      code: '15108727',
      email: 'rasel.rana@dbl-group.com',
      reason: null,
    },
  ],
  requester: {
    name: 'Moniruzzaman Monir',
    designation: 'IT Infrastructure',
    department: 'Glory Complex',
    phone: '01332827480',
  },
  confirmUrl: 'https://talenthub.dbl-group.com/it-request/abc123',
};

describe('the request to IT', () => {
  it('reads like DBL’s own request, with the confirmation link', () => {
    expect(renderItRequest(glory).text).toBe(
      [
        'Dear Farhad bhai,',
        '',
        'Hope you are doing well.',
        '',
        'Please find below two requests from Glory Textile & Apparels Ltd. (RMG Division).',
        '',
        '1. New Email Account Creation',
        '',
        'Employee Name: Sudansha Kirtonia',
        'Preferred Email Address: quality.accesories@glory-dbl.com',
        'New Employee: Yes',
        'Email Platform: Google',
        'Purpose: This account will be used to communicate with buyers, buying houses, suppliers and the marketing team.',
        '',
        "2. Deletion of Terminated Employee's Email Account",
        '',
        'The following employee has left the company. Kindly delete the email account.',
        '',
        'Employee Name: Md. Rasel Rana',
        'Employee Code: 15108727',
        'Email Address: rasel.rana@dbl-group.com',
        '',
        'Please confirm once both requests are completed, using the button below. It records the new address in DBL HRM and lets HR know.',
        '',
        'https://talenthub.dbl-group.com/it-request/abc123',
        '',
        'Warm Regards,',
        '',
        'Moniruzzaman Monir',
        'IT Infrastructure | Glory Complex | DBL Group',
        'Mobile: 01332827480',
        '',
      ].join('\n'),
    );
  });

  it('uses DBL’s subject, naming the hire so requests do not thread together', () => {
    expect(renderItRequest(glory).subject).toBe(
      "Request for New Email Account Creation and Deletion of Terminated Employee's Email — Sudansha Kirtonia",
    );
    expect(itRequestSubject({ employeeName: 'A B', deletions: [] })).toBe(
      'Request for New Email Account Creation — A B',
    );
  });

  it('is one unnumbered request when nobody is being replaced', () => {
    const text = renderItRequest({ ...glory, deletions: [] }).text;
    expect(text).toContain('Please find below a request from');
    expect(text).toContain('\nNew Email Account Creation\n');
    expect(text).not.toContain('1. ');
    expect(text).not.toContain('Deletion');
    expect(text).toContain(
      'Please confirm once the account is created, using the button below.',
    );
  });

  it('lets IT choose the address when HR gives none', () => {
    expect(renderItRequest({ ...glory, preferredEmail: '  ' }).text).toContain(
      'Preferred Email Address: To be assigned by IT',
    );
  });

  it('adds what the system knows about the hire when it has it', () => {
    const text = renderItRequest({
      ...glory,
      employeeId: '15112345',
      designation: 'Executive',
      department: 'Quality',
      joiningDate: new Date('2026-10-15T00:00:00Z'),
    }).text;
    expect(text).toContain(
      'Employee Name: Sudansha Kirtonia\nEmployee ID: 15112345\nDesignation: Executive\nDepartment: Quality\nPreferred Email Address',
    );
    expect(text).toContain(
      'Email Platform: Google\nJoining Date: 15 October 2026\nPurpose',
    );
  });

  it('asks for every leaver, in the plural, with the reason', () => {
    const text = renderItRequest({
      ...glory,
      deletions: [
        {
          name: 'A One',
          code: '1',
          email: 'a@dbl-group.com',
          reason: 'Resigned',
        },
        { name: 'B Two', code: null, email: 'b@dbl-group.com', reason: null },
      ],
    }).text;
    expect(text).toContain(
      'The following employees have left the company. Kindly delete their email accounts.',
    );
    expect(text).toContain(
      'Employee Name: A One\nEmployee Code: 1\nEmail Address: a@dbl-group.com\nReason for leaving: Resigned',
    );
    expect(text).toContain(
      'Employee Name: B Two\nEmail Address: b@dbl-group.com',
    );
  });

  it('says the link comes later in a preview', () => {
    const text = renderItRequest({ ...glory, confirmUrl: null }).text;
    expect(text).toContain(
      'Please confirm once both requests are completed. (The confirmation link is added when the request is sent.)',
    );
    expect(text).not.toContain('http');
  });

  it('escapes whatever HR typed in the HTML version', () => {
    const html = renderItRequest({ ...glory, purpose: '<b>x</b> & "y"' }).html;
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain(
      'href="https://talenthub.dbl-group.com/it-request/abc123"',
    );
  });

  it('signs off with just the group when the requester has no role on file', () => {
    const text = renderItRequest({
      ...glory,
      requester: { name: 'Admin' },
    }).text;
    expect(text.trimEnd().endsWith('Warm Regards,\n\nAdmin\nDBL Group')).toBe(
      true,
    );
  });
});

describe('the reply from IT', () => {
  const base = {
    requesterName: 'Moniruzzaman Monir',
    requestSubject:
      "Request for New Email Account Creation and Deletion of Terminated Employee's Email — Sudansha Kirtonia",
    employeeName: 'Sudansha Kirtonia',
    createdEmail: 'quality.accesories@glory-dbl.com',
    completedByName: 'Md. Farhad Hossain',
  };

  it('reads like DBL’s own reply when both are done', () => {
    const mail = renderItCompletion({
      ...base,
      deletions: [
        {
          name: 'Md. Rasel Rana',
          code: '15108727',
          email: 'rasel.rana@dbl-group.com',
          reason: null,
          deleted: true,
        },
      ],
    });
    expect(mail.subject).toBe(`Re: ${base.requestSubject}`);
    expect(mail.text).toBe(
      [
        'Dear Moniruzzaman,',
        '',
        'Both requests have been completed successfully as per your request.',
        '',
        'New Email Account Created',
        '',
        'Employee Name: Sudansha Kirtonia',
        'Email Address: quality.accesories@glory-dbl.com',
        '',
        'Email Account Deleted',
        '',
        'Employee Name: Md. Rasel Rana',
        'Employee Code: 15108727',
        'Email Address: rasel.rana@dbl-group.com',
        '',
        'Thanks & Regards,',
        '',
        'Md. Farhad Hossain',
        '',
      ].join('\n'),
    );
  });

  it('is one request completed when nobody was being replaced', () => {
    const text = renderItCompletion({ ...base, deletions: [] }).text;
    expect(text).toContain(
      'The request has been completed successfully as per your request.',
    );
    expect(text).not.toContain('Deleted');
  });

  it('says plainly what was not deleted, with IT’s note', () => {
    const text = renderItCompletion({
      ...base,
      note: 'Mailbox handed to the line manager first.',
      deletions: [
        {
          name: 'A One',
          code: '1',
          email: 'a@dbl-group.com',
          reason: null,
          deleted: false,
        },
      ],
    }).text;
    expect(text).toContain(
      'The account below was not deleted — please see the note.',
    );
    expect(text).toContain('Email Account Not Deleted\n\nEmployee Name: A One');
    expect(text).toContain('Note: Mailbox handed to the line manager first.');
  });

  it('greets a colleague when the requester is gone', () => {
    expect(
      renderItCompletion({ ...base, requesterName: null, deletions: [] }).text,
    ).toMatch(/^Dear Colleague,/);
  });
});

describe('the purpose HR starts from', () => {
  it('writes a purpose from the post', () => {
    expect(defaultItPurpose('Executive', 'Quality')).toBe(
      'This account will be used for official communication as Executive, Quality.',
    );
    expect(defaultItPurpose(null, null)).toBe(
      'This account will be used for official communication.',
    );
  });
});
