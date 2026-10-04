import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { PublicApplyDto } from './dto/candidate.dto';

/**
 * The careers-page form, through the same transform and validation the
 * global ValidationPipe runs (implicit conversion on — which is what turned
 * "40,000" into NaN before the field read the raw body).
 */
function check(salaryExpectation: unknown) {
  const dto = plainToInstance(
    PublicApplyDto,
    { name: 'Rahim Uddin', email: 'rahim@example.com', salaryExpectation },
    { enableImplicitConversion: true },
  );
  return { dto, errors: validateSync(dto, { whitelist: true }) };
}

describe('PublicApplyDto — expected salary', () => {
  it('reads a figure however it is written', () => {
    for (const [typed, figure] of [
      ['40000', 40000],
      ['40,000', 40000],
      ['40 000', 40000],
      ['Tk 40,000', 40000],
      ['BDT 1,20,000', 120000],
      ['35000.50', 35000.5],
    ] as const) {
      const { dto, errors } = check(typed);
      expect(errors).toEqual([]);
      expect(dto.salaryExpectation).toBe(figure);
    }
  });

  it('takes a box with no figure in it as no answer, not a refusal', () => {
    for (const typed of ['', 'Negotiable', undefined]) {
      const { dto, errors } = check(typed);
      expect(errors).toEqual([]);
      expect(dto.salaryExpectation).toBeUndefined();
    }
  });

  it('refuses what cannot be a figure, saying so', () => {
    const { errors } = check('1.2.3');
    expect(errors[0]?.constraints?.isNumber).toMatch(/Expected salary/);
  });
});
