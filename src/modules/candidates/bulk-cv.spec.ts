import { bulkCandidateNames, nameFromFileName } from './bulk-cv';

describe('nameFromFileName', () => {
  it('strips the extension, separators and CV noise', () => {
    expect(nameFromFileName('CV_Md_Rahim_Uddin.pdf')).toBe('Md Rahim Uddin');
    expect(nameFromFileName('Nusrat-Jahan-Resume (1).pdf')).toBe(
      'Nusrat Jahan',
    );
    expect(nameFromFileName('KARIM HOSSAIN updated cv 2026.pdf')).toBe(
      'Karim Hossain',
    );
  });

  it('keeps mixed-case names as written', () => {
    expect(nameFromFileName('McDonald_Sabbir.pdf')).toBe('McDonald Sabbir');
  });

  it('never returns an unusable name', () => {
    expect(nameFromFileName('CV.pdf')).toBe('Unnamed candidate');
    expect(nameFromFileName('12345.pdf')).toBe('Unnamed candidate');
  });
});

describe('bulkCandidateNames', () => {
  const files = ['CV_Md_Rahim.pdf', 'Nusrat_Jahan.pdf'];

  it('uses the names the recruiter reviewed, in file order', () => {
    expect(bulkCandidateNames('["Rahim Uddin","Nusrat J."]', files)).toEqual([
      'Rahim Uddin',
      'Nusrat J.',
    ]);
  });

  it('falls back to the filename for a blank, missing or malformed entry', () => {
    expect(bulkCandidateNames('["", 7]', files)).toEqual([
      'Md Rahim',
      'Nusrat Jahan',
    ]);
    expect(bulkCandidateNames('not json', files)).toEqual([
      'Md Rahim',
      'Nusrat Jahan',
    ]);
    expect(bulkCandidateNames(undefined, files)).toEqual([
      'Md Rahim',
      'Nusrat Jahan',
    ]);
  });
});
