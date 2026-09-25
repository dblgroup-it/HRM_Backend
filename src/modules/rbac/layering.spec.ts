import { layerOrder } from './layering';

const at = (d: number) => new Date(2026, 8, d);

describe('layerOrder', () => {
  it('closes the gap when the first priority is removed', () => {
    // The case that prompted it: 1st moved to Factory HR Head, 2 and 3 left.
    expect(
      layerOrder([
        { id: 'c', priority: 3, createdAt: at(3) },
        { id: 'b', priority: 2, createdAt: at(2) },
      ]),
    ).toEqual(['b', 'c']);
  });

  it('puts a newly added Factory HR last', () => {
    expect(
      layerOrder([
        { id: 'new', priority: null, createdAt: at(20) },
        { id: 'a', priority: 1, createdAt: at(1) },
        { id: 'b', priority: 2, createdAt: at(2) },
      ]),
    ).toEqual(['a', 'b', 'new']);
  });

  it('orders a unit nobody has layered yet by when they were added', () => {
    expect(
      layerOrder([
        { id: 'later', priority: null, createdAt: at(9) },
        { id: 'first', priority: null, createdAt: at(1) },
      ]),
    ).toEqual(['first', 'later']);
  });
});
