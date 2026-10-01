import { SingleFlight } from './single-flight';

describe('SingleFlight', () => {
  it('runs a key once while in flight and shares the result', async () => {
    const sf = new SingleFlight();
    let runs = 0;
    let release!: () => void;
    const work = () =>
      new Promise<string>((r) => {
        runs++;
        release = () => r('done');
      });
    const a = sf.run('k', work);
    const b = sf.run('k', work);
    expect(sf.isRunning('k')).toBe(true);
    release();
    await expect(Promise.all([a, b])).resolves.toEqual(['done', 'done']);
    expect(runs).toBe(1);
    expect(sf.isRunning('k')).toBe(false);
  });

  it('runs again once the first has finished, even after a failure', async () => {
    const sf = new SingleFlight();
    await expect(sf.run('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(sf.run('k', () => Promise.resolve(2))).resolves.toBe(2);
  });

  it('keeps different keys apart', async () => {
    const sf = new SingleFlight();
    const [a, b] = await Promise.all([
      sf.run('a', () => Promise.resolve(1)),
      sf.run('b', () => Promise.resolve(2)),
    ]);
    expect([a, b]).toEqual([1, 2]);
  });
});
