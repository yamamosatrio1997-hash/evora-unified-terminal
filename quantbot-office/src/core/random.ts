export const rand = (min: number, max: number): number => min + Math.random() * (max - min);

export const randInt = (min: number, max: number): number => Math.floor(rand(min, max + 1));

export const chance = (p: number): boolean => Math.random() < p;

export function pick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() on empty list');
  return items[Math.floor(Math.random() * items.length)];
}

export function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
