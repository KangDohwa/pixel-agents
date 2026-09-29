import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { appearanceIndex, readAppearance } from '../../core/src/appearance.js';
import { decodeAllCharacters, decodeLayeredCharacters } from '../../core/src/assets/loader.js';
import { getCharacterSprite } from '../src/office/engine/characters.js';
import { reconcileExistingAgents } from '../src/office/engine/existingAgents.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import {
  getCharacterSprites,
  getLoadedCharacterCount,
  setCharacterTemplates,
} from '../src/office/sprites/spriteData.js';
import { setProviderCapabilities } from '../src/office/toolUtils.js';
import { CharacterState, Direction } from '../src/office/types.js';

const assets = fileURLToPath(new URL('../public/assets', import.meta.url));
const layered = decodeLayeredCharacters(assets);
const legacy = decodeAllCharacters(assets);

test('all 27 combinations have three articulated directions and seven 16x32 poses', () => {
  assert.equal(layered.length, 27);
  const identities = new Set<string>();
  for (const character of layered) {
    identities.add(JSON.stringify(character));
    assert.notDeepEqual(character.down[1], character.up[1], 'back must be a real different view');
    for (const direction of ['down', 'up', 'right'] as const) {
      const frames = character[direction];
      assert.equal(frames.length, 7);
      for (const frame of frames) {
        assert.equal(frame.length, 32);
        assert.ok(frame.every((row) => row.length === 16));
        assert.ok(frame.flat().some(Boolean));
        assert.ok(frame.flat().every((p) => p === '' || /^#[0-9A-F]{6}$/.test(p)));
      }
      assert.notDeepEqual(frames[0].slice(24), frames[2].slice(24), 'legs articulate');
      assert.notDeepEqual(frames[0].slice(18, 23), frames[2].slice(18, 23), 'arms swing');
      assert.notDeepEqual(frames[3], frames[4], 'typing hands move');
      assert.notDeepEqual(frames[5], frames[6], 'reading hands move');
      assert.notDeepEqual(frames[3], frames[5], 'typing and reading are distinct poses');
      assert.deepEqual(
        frames[0].slice(0, 16),
        frames[2].slice(0, 16),
        'motion is not whole-sprite bob',
      );
    }
    for (const x of [7, 8]) {
      const hand = character.right[1][21][x];
      assert.ok(hand, 'near hand is visible above clothes');
      assert.ok(
        parseInt(hand.slice(1, 3), 16) > parseInt(hand.slice(5, 7), 16),
        'hand keeps source skin color',
      );
      assert.equal(character.right[3][19][x + 2], hand, 'typing moves the same real hand pixels');
    }
  }
  assert.equal(identities.size, 27);
});

test('renderer resolves layers, mirrors left, preserves palette count and falls back on reload', () => {
  setCharacterTemplates(legacy, layered);
  assert.equal(getLoadedCharacterCount(), 6);
  const appearance = { head: 2, body: 1, clothes: 0 };
  assert.equal(appearanceIndex(appearance), 21);
  const sprites = getCharacterSprites(4, 120, appearance);
  assert.deepEqual(sprites.walk[Direction.DOWN][1], layered[21].down[1]);
  assert.deepEqual(
    sprites.walk[Direction.LEFT][0],
    layered[21].right[0].map((row) => [...row].reverse()),
  );
  const os = new OfficeState();
  os.addAgent(1, 4);
  const ch = os.characters.get(1)!;
  ch.dir = Direction.RIGHT;
  ch.state = CharacterState.WALK;
  ch.frame = 2;
  assert.equal(getCharacterSprite(ch, sprites), sprites.walk[Direction.RIGHT][2]);
  ch.state = CharacterState.TYPE;
  ch.currentTool = null;
  ch.frame = 1;
  assert.equal(getCharacterSprite(ch, sprites), sprites.typing[Direction.RIGHT][1]);
  setProviderCapabilities({ readingTools: ['Read'], subagentToolNames: [] });
  ch.currentTool = 'Read';
  assert.equal(getCharacterSprite(ch, sprites), sprites.reading[Direction.RIGHT][1]);
  ch.state = CharacterState.IDLE;
  assert.equal(getCharacterSprite(ch, sprites), sprites.walk[Direction.RIGHT][1]);
  setProviderCapabilities({ readingTools: [], subagentToolNames: [] });
  setCharacterTemplates(legacy);
  assert.equal(getCharacterSprites(4, 120, appearance), getCharacterSprites(4, 120));
  setCharacterTemplates(legacy, layered);
  assert.notEqual(
    getCharacterSprites(4, 120, appearance),
    sprites,
    'asset reload invalidates cache',
  );
});

test('seat appearance restores existing characters, defers safely and follows subagents', () => {
  const os = new OfficeState();
  os.addAgent(1, 2);
  const appearance = { head: 1, body: 2, clothes: 0 };
  reconcileExistingAgents(
    os,
    [1],
    { 1: { appearance, appearanceCustomized: false } },
    {},
    true,
    [],
  );
  assert.deepEqual(os.getPersistableSeats()[1].appearance, appearance);
  assert.equal(os.getPersistableSeats()[1].appearanceCustomized, false);
  os.setAgentAppearance(1, appearance);
  assert.equal(
    os.getPersistableSeats()[1].appearanceCustomized,
    true,
    'explicit default choice is preserved',
  );
  const child = os.addSubagent(1, 'tool');
  assert.deepEqual(os.characters.get(child)?.appearance, appearance);
  os.setAgentAppearance(1, null);
  assert.equal(os.characters.get(child)?.appearance, null);
  assert.equal(os.getPersistableSeats()[child], undefined);
  const pending: import('../src/office/engine/existingAgents.js').PendingAgent[] = [];
  reconcileExistingAgents(os, [2], { 2: { appearance } }, {}, false, pending);
  assert.deepEqual(pending[0].appearance, appearance);
  assert.equal(os.characters.has(2), false);
  assert.equal(readAppearance({ head: -1, body: 0, clothes: 0 }), null);
  assert.equal(readAppearance({ head: 0, body: 3, clothes: 0 }), null);
  assert.equal(readAppearance({ head: 0, body: 0, clothes: 0.5 }), null);
  assert.equal(readAppearance(undefined), null);
});

test('raw source assets and metadata are shipped in the repository', () => {
  for (const name of ['heads.png', 'bodies.png', 'clothes.png', 'manifest.json'])
    assert.ok(fs.statSync(assets + '/characters/layered/' + name).size > 0);
  assert.deepEqual(decodeLayeredCharacters(assets + '/missing'), []);
});
