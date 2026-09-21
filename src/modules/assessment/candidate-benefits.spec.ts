import { benefitsConflict, normaliseBenefits } from './candidate-benefits';

describe('candidate benefits', () => {
  it('refuses lunch both full and partial', () => {
    expect(benefitsConflict(['lunch_full', 'lunch_partial'])).toMatch(/Lunch/);
  });

  it('refuses pick and drop both free and paid', () => {
    expect(benefitsConflict(['transport_free', 'transport_paid'])).toMatch(
      /Pick and drop/,
    );
  });

  it('accepts one of each pair alongside anything else', () => {
    expect(
      benefitsConflict(['lunch_partial', 'transport_paid', 'tax_paid']),
    ).toBeNull();
  });

  it('stores keys once, in catalogue order', () => {
    expect(normaliseBenefits(['tax_paid', 'dormitory', 'tax_paid'])).toEqual([
      'dormitory',
      'tax_paid',
    ]);
  });
});
