import { firstName } from './first-name';

describe('firstName', () => {
  it('takes the first word of an ordinary name', () => {
    expect(firstName('Nusrat Jahan')).toBe('Nusrat');
    expect(firstName('Tanvir Ahmed')).toBe('Tanvir');
    expect(firstName('Rahim')).toBe('Rahim');
  });

  it('skips Md. / Mst. and their spellings — "Dear Md.," is a letter nobody checked', () => {
    expect(firstName('Md. Rahim Uddin')).toBe('Rahim');
    expect(firstName('MD RAHIM UDDIN')).toBe('Rahim');
    expect(firstName('Mohammad Rafiqul Islam')).toBe('Rafiqul');
    expect(firstName('Muhammad Kamrul Hasan')).toBe('Kamrul');
    expect(firstName('Mst. Shirin Akter')).toBe('Shirin');
    expect(firstName('Most. Rokeya Begum')).toBe('Rokeya');
  });

  it('skips titles, and more than one of them', () => {
    expect(firstName('Dr. Md. Kamal Hossain')).toBe('Kamal');
    expect(firstName('Engr. Sk. Habibur Rahman')).toBe('Habibur');
    expect(firstName('Mr. John Smith')).toBe('John');
  });

  it('skips initials, with or without the dots', () => {
    expect(firstName('A.K.M. Fazlul Haque')).toBe('Fazlul');
    expect(firstName('AKM Fazlul Haque')).toBe('Fazlul');
    expect(firstName('S.M. Nazmul Hasan')).toBe('Nazmul');
    expect(firstName('M. Asaduzzaman')).toBe('Asaduzzaman');
  });

  it('keeps Abdul / Abdur / Abu / Al with the word that completes them', () => {
    expect(firstName('Md. Abdur Rahman')).toBe('Abdur Rahman');
    expect(firstName('Abdul Karim')).toBe('Abdul Karim');
    expect(firstName('Abu Bakar Siddique')).toBe('Abu Bakar');
    expect(firstName('Md. Al Amin')).toBe('Al Amin');
    expect(firstName('AL MAMUN')).toBe('Al Mamun');
    expect(firstName('Al-Amin Hossain')).toBe('Al-Amin');
  });

  it('writes a name typed in one case properly, and leaves mixed case alone', () => {
    expect(firstName('rahim uddin')).toBe('Rahim');
    expect(firstName('NUSRAT JAHAN')).toBe('Nusrat');
    expect(firstName('McKenzie Rahman')).toBe('McKenzie');
  });

  it('falls back to the whole name when nothing but prefixes is left', () => {
    expect(firstName('Mohammad')).toBe('Mohammad');
    expect(firstName('MD.')).toBe('Md.');
  });

  it('is empty for no name at all', () => {
    expect(firstName('')).toBe('');
    expect(firstName('   ')).toBe('');
    expect(firstName(null)).toBe('');
  });
});
