import type { CharacterAppearance } from './messages.js';

/** Missing/invalid appearance means Legacy, including saves made before layers. */
export function readAppearance(value: unknown): CharacterAppearance | null {
  if (!value || typeof value !== 'object') return null;
  const { head, body, clothes } = value as CharacterAppearance;
  if (![head, body, clothes].every((n) => Number.isInteger(n) && n >= 0 && n < 3)) return null;
  return { head, body, clothes };
}

export function appearanceIndex(value: CharacterAppearance): number {
  return value.head * 9 + value.body * 3 + value.clothes;
}

export function defaultAppearance(id: number): CharacterAppearance {
  const index = Math.abs(id) % 27;
  return { head: Math.floor(index / 9), body: Math.floor(index / 3) % 3, clothes: index % 3 };
}
