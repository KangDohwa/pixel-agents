/**
 * Provider registry: re-exports all bundled providers.
 *
 * New CLI providers implement HookProvider or FileProvider and join the registry.
 * Hook providers also join the consent list.
 *
 * The adapter (VS Code extension, standalone CLI, etc.) imports from here rather
 * than reaching into each provider directory directly.
 */

import type { ProviderCapabilities } from '../../../core/src/messages.js';
import type { AgentProvider, HookProvider } from '../../../core/src/provider.js';
import { codexProvider } from './file/codex/codex.js';
import { claudeProvider } from './hook/claude/claude.js';
import { geminiProvider } from './hook/gemini/gemini.js';

export { claudeProvider, codexProvider, geminiProvider };
export { copyHookScript } from './hook/claude/claudeHookInstaller.js';

/** Every bundled hook provider, in registration order. The consent gate loops
 *  over this at the webviewReady handshake (one ask per provider that needs
 *  one) and `hooksConsentResponse` resolves its provider id against it. */
export const hookProviders: readonly HookProvider[] = [claudeProvider, geminiProvider];
export const providers: readonly AgentProvider[] = [claudeProvider, codexProvider, geminiProvider];
export function providerById(id: unknown): AgentProvider | undefined {
  return typeof id === 'string' ? providers.find((p) => p.id === id) : undefined;
}

/** New providers use namespaced tool keys on the wire, so their taxonomy can
 * coexist with unchanged Claude animation names without editing sprite code. */
export function providerCapabilities(): ProviderCapabilities {
  return {
    type: 'providerCapabilities',
    readingTools: providers.flatMap((p) =>
      [...p.readingTools].map((tool) => (p.id === 'claude' ? tool : `${p.id}/${tool}`)),
    ),
    subagentToolNames: [...claudeProvider.subagentToolNames],
    providers: providers.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      hooks: p.kind === 'hook',
    })),
  };
}

/** Resolve a wire-supplied provider id, or undefined for an unknown one —
 *  the caller writes nothing on undefined (fail-closed, like a junk choice). */
export function hookProviderById(id: unknown): HookProvider | undefined {
  return typeof id === 'string' ? hookProviders.find((p) => p.id === id) : undefined;
}
