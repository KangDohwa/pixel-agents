# Pixel Agents (Personal)

A personal fork of [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents). Local Claude Code, Codex and Gemini CLI sessions appear as characters in a small office. They walk to desks, type, read and show the activity their provider can report.

This fork adds layered characters and local provider support. Install it from this repository. The upstream Marketplace, Open VSX and npm packages do not contain these changes.

## Local installation

Use Node.js 22 as specified by `.nvmrc`, or a compatible version. VS Code requires version 1.105.0 or later. Install and sign in to the agent CLIs you want to use separately.

```bash
git clone https://github.com/KangDohwa/pixel-agents.git
cd pixel-agents
npm ci
npm run build
```

For the browser office, run the built CLI from the project you want to watch. Use the full path to your clone, for example on Windows:

```powershell
node "C:\path\to\pixel-agents\dist\cli.js"
```

Open the local URL printed by the server, including its token. Stop the server with Ctrl+C. Start Claude, Codex or Gemini in your own terminal. **Watch All Sessions** includes sessions from other projects.

For VS Code, press **F5** in this repository to open an Extension Development Host. To install a local VSIX instead:

```bash
npm exec --package=@vscode/vsce@4.0.0 -- vsce package --no-dependencies --allow-star-activation --out pixel-agents-personal.vsix
code --install-extension pixel-agents-personal.vsix --force
```

Reload VS Code, then open **Pixel Agents: Show Panel**. Choose an agent provider beside **+ Agent**. The selected CLI must be on PATH. Claude launches into a tracked terminal; Codex and Gemini launch into normal terminals and are discovered from their logs. Detected external sessions appear without a linked VS Code terminal.

Packaging a VSIX is local. There is no Marketplace, Open VSX or npm publishing step. The personal extension ID is `KangDohwa.pixel-agents`; disable the upstream extension if you want only one office.

## Providers

| Provider    | Activity source                            | Limits                                                                                                                                  |
| ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Hooks, with transcript fallback            | Enable **Instant Detection (Hooks)** for explicit lifecycle and approval events.                                                        |
| Codex       | Local rollout JSONL                        | Approval waits and process exit are not reliably observable. Compressed `.jsonl.zst` archives are not read.                             |
| Gemini CLI  | Local JSON or replay JSONL; optional hooks | File-only records do not prove live turn completion. Enable **Gemini CLI Hooks (optional)** for explicit lifecycle and approval events. |

Codex and Gemini discovery starts with recently modified sessions (within five minutes) and can restore persisted sessions. Active sessions become **Unknown (not observable)** after 60 seconds without fresh activity. Unknown and interrupted states do not play a completion sound. Token labels show usage reported by the CLI; missing usage stays unknown. Very large active histories can take more time and memory to read.

Hook setup requires consent and changes only the named provider's hook configuration. Settings can disable the hooks again.

## Character appearance

New characters use layered artwork. Existing saved characters keep their legacy appearance.

1. Open **Settings** and choose an **Agent** under **Character appearance**.
2. Select **Layered**, then choose **Head**, **Body** and **Clothes** independently.
3. Changes appear immediately and save automatically. Choose **Legacy** to return to that agent's original palette.

There are three choices per part, giving 27 combinations. The preview shows front, back and right. Left mirrors right. Each direction has seven 16×32 frames for walking, typing and reading. These movements are generated from the separate static layers, with articulated arms and legs. Temporary sub-agents use their parent's appearance. Recognized child sessions inherit it when first linked; customized choices and older saved appearances are preserved.

Appearance is stored with seat assignments in `~/.pixel-agents/standalone-state.json` or `~/.pixel-agents/vscode-state.json`. The two runtimes keep separate agent identities and choices. Layout exports do not include agent appearance. Missing layered assets fall back to legacy sprites without removing the saved selection. External `char_N.png` characters keep their existing palette indices.

The source PNGs and their crop/anchor metadata are in `webview-ui/public/assets/characters/layered/` and included in local packages.

## Office layout

Click **Layout** to paint floors, walls, carpets and named Areas; place furniture and pets; and undo or redo changes. Layouts support JSON import/export and can grow to 64×64 tiles.

Use **Settings → Add Asset Directory** for external characters, pets and furniture. See [external assets](docs/external-assets.md) for the directory structure. The layer compositor is calibrated to the bundled artwork; arbitrary external layer packs are not supported.

## Development

```bash
npm run build
npm test
npm run asyncapi:validate
npm run format:check
npm run lint
```

`npm run build` regenerates the message types from `core/asyncapi.yaml`, checks types and builds both hosts and the webview. Do not edit `core/src/messages.ts` by hand.

Focused browser coverage uses the built standalone server and isolated test homes:

```bash
npm exec -- playwright test --config e2e/providers.config.ts
npm exec -- playwright test --config e2e/appearance.config.ts
```

The existing Playwright browser must be installed. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [E2E guide](e2e/README.md) for the full suite. Browser tests of the VS Code transport do not replace an Electron extension-host test.

## Credits and license

Pixel Agents is based on the work of the [upstream project and its contributors](https://github.com/pixel-agents-hq/pixel-agents). The six legacy characters are based on [JIK-A-4's Metro City character pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack). Existing assets and their credits are retained.

The original head, body and clothing PNGs were generated separately with OpenAI image generation for this fork.

Code remains under the [MIT License](LICENSE). See the original asset source for its terms.
