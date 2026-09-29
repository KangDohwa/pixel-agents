import { useEffect, useRef, useState } from 'react';

import type { CharacterAppearance } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { getCharacterSprites } from '../office/sprites/spriteData.js';
import { Direction } from '../office/types.js';
import { transport } from '../transport/index.js';

export function AppearancePicker({
  officeState,
  agents,
  available,
}: {
  officeState: OfficeState;
  agents: number[];
  available: boolean;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [, refresh] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const id = chosen !== null && agents.includes(chosen) ? chosen : agents[0];
  const character = officeState.characters.get(id);
  const appearance = character?.appearance ?? null;
  const sprites = character
    ? getCharacterSprites(character.palette, character.hueShift, appearance)
    : null;
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 192, 128);
    if (sprites)
      [Direction.DOWN, Direction.UP, Direction.RIGHT].forEach((direction, index) => {
        ctx.drawImage(getCachedSprite(sprites.walk[direction][1], 4), index * 64, 0);
      });
  }, [sprites]);
  const change = (value: CharacterAppearance | null) => {
    officeState.setAgentAppearance(id, value);
    transport.send({ type: 'saveAgentSeats', seats: officeState.getPersistableSeats() });
    refresh((n) => n + 1);
  };
  const selectClass = 'bg-bg text-text border-2 border-border px-4 py-2 text-xs';
  return (
    <fieldset className="px-10 py-4 flex flex-col gap-4">
      <legend className="text-xs">Character appearance</legend>
      {agents.length === 0 ? (
        <p className="text-xs text-text-muted">Start an agent to choose its appearance.</p>
      ) : (
        <>
          <label className="text-xs flex justify-between">
            Agent
            <select
              aria-label="Appearance agent"
              className={selectClass}
              value={id}
              onChange={(e) => setChosen(Number(e.target.value))}
            >
              {agents.map((agentId) => (
                <option key={agentId} value={agentId}>
                  Agent {agentId}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs flex justify-between">
            Style
            <select
              aria-label="Character style"
              className={selectClass}
              value={appearance ? 'layered' : 'legacy'}
              onChange={(e) =>
                change(e.target.value === 'legacy' ? null : { head: 0, body: 0, clothes: 0 })
              }
            >
              <option value="layered" disabled={!available}>
                Layered
              </option>
              <option value="legacy">Legacy</option>
            </select>
          </label>
          {appearance &&
            (['head', 'body', 'clothes'] as const).map((part) => (
              <label key={part} className="text-xs flex justify-between">
                {{ head: 'Head', body: 'Body', clothes: 'Clothes' }[part]}
                <select
                  aria-label={{ head: 'Head', body: 'Body', clothes: 'Clothes' }[part]}
                  className={selectClass}
                  disabled={!available}
                  value={appearance[part]}
                  onChange={(e) => change({ ...appearance, [part]: Number(e.target.value) })}
                >
                  {[0, 1, 2].map((value) => (
                    <option key={value} value={value}>
                      {
                        {
                          head: ['Chestnut', 'Auburn', 'Wizard'],
                          body: ['Brown boots', 'Gold boots', 'Teal boots'],
                          clothes: ['Green vest', 'Cream shirt', 'Blue overalls'],
                        }[part][value]
                      }
                    </option>
                  ))}
                </select>
              </label>
            ))}
          {!available && (
            <p className="text-xs text-text-muted">
              Layered assets unavailable. Showing the legacy character.
            </p>
          )}
          <canvas
            ref={canvas}
            width={192}
            height={128}
            aria-label="Character preview: front, back and right"
            className="self-center"
          />
          <p className="text-2xs text-text-muted">
            Saved automatically for this agent. Left mirrors right.
          </p>
        </>
      )}
    </fieldset>
  );
}
