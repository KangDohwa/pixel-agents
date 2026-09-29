import { rgbaToHex } from './colorUtils.js';
import type { CharacterDirectionSprites } from './types.js';

type Sprite = string[][];
type Layer = 'heads' | 'bodies' | 'clothes';
type Cell = [number, number, number, number, number, number];
export interface LayerManifest {
  size: [number, number];
  cells: Record<Layer, Cell[][]>;
  destinationAnchors: Record<Layer, [number, number]>;
  scale: number;
}
export interface LayerImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

const blank = (): Sprite => Array.from({ length: 32 }, () => Array<string>(16).fill(''));

/** Sample the full anchored cell; never stretch each layer's bounding box. */
function sample(image: LayerImage, cell: Cell, anchor: [number, number], scale: number): Sprite {
  if (
    !Array.isArray(cell) ||
    cell.length !== 6 ||
    !cell.every(Number.isFinite) ||
    !Array.isArray(anchor) ||
    anchor.length !== 2 ||
    !anchor.every(Number.isFinite)
  )
    throw new Error('Invalid layer cell or anchor');
  const [sx, sy, w, h, ax, ay] = cell;
  if (sx < 0 || sy < 0 || w <= 0 || h <= 0 || sx + w > image.width || sy + h > image.height)
    throw new Error('Layer cell is outside its PNG');
  const out = blank();
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 16; x++) {
      const px = Math.floor(ax + (x + 0.5 - anchor[0]) / scale);
      const py = Math.floor(ay + (y + 0.5 - anchor[1]) / scale);
      if (px < sx || px >= sx + w || py < sy || py >= sy + h) continue;
      const i = (py * image.width + px) * 4;
      if (image.data[i + 3] >= 128)
        out[y][x] = rgbaToHex(image.data[i], image.data[i + 1], image.data[i + 2], 255);
    }
  }
  return out;
}

function overlay(target: Sprite, source: Sprite): void {
  source.forEach((row, y) =>
    row.forEach((pixel, x) => {
      if (pixel) target[y][x] = pixel;
    }),
  );
}

/** Seven authored poses for these normalized bodies, shared by Node and browser. */
function pose(body: Sprite, head: Sprite, direction: number, frame: number): Sprite {
  const out = blank();
  const limbs: [number, number, string][] = [];
  body.forEach((row, y) =>
    row.forEach((pixel, x) => {
      if (!pixel) return;
      // ponytail: limb masks match the bundled art; remeasure for other layer packs.
      const arm = y >= 18 && y <= 21 && (direction === 2 ? x >= 7 && x <= 8 : x <= 4 || x >= 11);
      const leg = y >= 24;
      let dx = 0,
        dy = 0;
      if (frame === 0 || frame === 2) {
        const phase = frame === 0 ? 1 : -1;
        if (leg) {
          const side = x < 8 ? 1 : -1;
          if (direction === 2) dx = side * phase;
          else dy = side * phase;
        }
        if (arm) {
          dy = (x < 8 ? -1 : 1) * phase;
          if (direction === 2) dx = phase;
        }
      } else if (frame >= 3 && arm) {
        // Hands reach toward the desk to type, or lift together to read.
        dx = direction === 2 ? (frame < 5 ? 2 : 1) : x < 8 ? 1 : -1;
        dy = frame < 5 ? -1 - (frame % 2) : -3 - (frame % 2);
      }
      // Moving the near sleeve reveals the torso behind it, not a transparent hole.
      if (arm && direction === 2 && frame !== 1) out[y][x] = body[y][9];
      if (arm || leg) limbs.push([x + dx, y + dy, pixel]);
      else out[y][x] = pixel;
    }),
  );
  for (const [x, y, pixel] of limbs) if (x >= 0 && x < 16 && y >= 0 && y < 32) out[y][x] = pixel;
  overlay(out, head);
  return out;
}

/** Compose 27 combinations once at asset load, outside the render loop. */
export function composeLayeredCharacters(
  images: Record<Layer, LayerImage>,
  manifest: LayerManifest,
): CharacterDirectionSprites[] {
  if (!(manifest.scale > 0 && manifest.scale <= 1)) throw new Error('Invalid layer scale');
  const layers = {} as Record<Layer, Sprite[][]>;
  for (const key of ['heads', 'bodies', 'clothes'] as const) {
    const image = images[key];
    if (
      image.width !== manifest.size[0] ||
      image.height !== manifest.size[1] ||
      image.data.length !== image.width * image.height * 4
    )
      throw new Error(`Invalid ${key} PNG dimensions`);
    if (manifest.cells[key].length !== 3 || manifest.cells[key].some((row) => row.length !== 3))
      throw new Error('Expected three variants and three directions');
    layers[key] = manifest.cells[key].map((row) =>
      row.map((cell) => sample(image, cell, manifest.destinationAnchors[key], manifest.scale)),
    );
  }
  const result: CharacterDirectionSprites[] = [];
  for (let h = 0; h < 3; h++)
    for (let b = 0; b < 3; b++)
      for (let c = 0; c < 3; c++) {
        const character: CharacterDirectionSprites = { down: [], up: [], right: [] };
        (['down', 'up', 'right'] as const).forEach((direction, d) => {
          const body = layers.bodies[b][d].map((row) => [...row]);
          overlay(body, layers.clothes[c][d]);
          // The near hand is in front of the sleeve. Preserve only genuine skin pixels.
          if (d === 2) for (const x of [7, 8]) body[21][x] = layers.bodies[b][d][21][x];
          for (let f = 0; f < 7; f++)
            character[direction].push(pose(body, layers.heads[h][d], d, f));
        });
        result.push(character);
      }
  return result;
}
