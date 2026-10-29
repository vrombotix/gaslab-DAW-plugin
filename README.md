# AI DAW Prototype v0.1

A first end-to-end prototype for a **standalone AI music generation app that can hand generated stems directly to multiple DAWs**.

The current prototype implements the shared architecture and adapters for **Ardour, REAPER, Ableton Live, FL Studio and Logic Pro** (see [DAW support](#daw-support)). Ardour 9.x on Linux is the one exercised end to end.

## What the app does

1. **Sign in** to the music API.
2. **My songs** lists every song of that user; **Generate** creates a new one from a prompt.
3. Opening a song downloads its stems to a persistent local folder.
4. **Import into DAW** hands the stems to whichever DAW has a live bridge. Every DAW can also take them by dragging the stems out of the app.
5. **Export mix to API**: bounce your mix in the DAW, pick the file, and it is uploaded to that song. In dev mode, Ardour and REAPER can also **render the mix themselves** and upload it in one click.

The API is a stand-in built into the app (any email, password `demo`). It always returns the same four demo stems: Drums, Bass, Synth and Vocals. Its contract - sign-in, song list, download, upload - is in [schemas/api.md](schemas/api.md), so a real backend can replace it without changing the app.

## DAW support

| DAW | Platforms | How stems get in | Status |
|---|---|---|---|
| Ableton Live 12.0.5+ | macOS, Windows | Python Control Surface bridge: one new audio track per stem, clip at the playhead (`Track.create_audio_clip`) | Unverified in Live |
| FL Studio | macOS, Windows | Drag from the app - FL's scripting API cannot load audio files | Detect + launch |
| Logic Pro | macOS | Drag from the app - Logic has no scripting API | Detect + launch |
| Ardour 9 *(dev mode)* | Linux, macOS, Windows | Lua Editor Hook bridge, at the playhead; renders the mix on request (Ardour's export API) | Import exercised on a real install (Linux) |
| REAPER *(dev mode)* | Linux, macOS, Windows | Lua bridge loaded from `__startup.lua`, at the edit cursor; renders the mix on request, restoring the project's render settings | Unverified in REAPER |

**Dev mode.** Ardour and REAPER only exist when the agent runs with `AI_DAW_DEV=1`, which `npm run tauri dev` sets automatically. Release installers show Ableton Live, FL Studio and Logic Pro only, and never touch Ardour's or REAPER's script folders.

Every DAW also takes a drag: the stems in the Result panel (each one, or **Drag all stems**) are real files dragged with the OS's native drag-and-drop, so they drop into a DAW like files from Finder/Explorer.

The bridge protocol of Ardour, REAPER and Ableton is tested in CI against stubbed DAW APIs (see [Tests and CI](#tests-and-ci)); "unverified" means nobody has run it inside that DAW yet. On Windows the agent can't tell whether a DAW is running, so a bridge DAW shows as running once its bridge heartbeat appears.

## Downloads (macOS, Windows, Linux)

Installers are built by GitHub Actions, never by hand:

| Platform | Files |
|---|---|
| macOS 10.15+ (Apple Silicon and Intel, separate builds) | `.dmg` |
| Windows 10/11 x64 | `.msi` and `-setup.exe` |
| Linux x64 | `.AppImage`, `.deb`, `.rpm` |

To release: bump `version` in `apps/desktop/src-tauri/tauri.conf.json`, commit, then push a matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` reruns the full CI suite, builds all four installers and attaches them to a **draft** GitHub Release - check it, then click Publish.

The installers are not code-signed yet. macOS shows "unidentified developer" (right-click the app > Open, or System Settings > Privacy & Security > Open Anyway) and Windows SmartScreen shows "More info > Run anyway". Signing needs an Apple Developer ID and a Windows code-signing certificate added as repository secrets.

## Tests and CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Job | Runs on | What |
|---|---|---|
| Agent + bridges | Linux, macOS, Windows | `ctest`: C++ adapter unit tests (`native/tests/`), then `tests/test_agent.py` - the agent CLI against a stub of the API contract (sign-in, songs, download, upload, rejected tokens, unsafe names), dev-mode gating, bridge installation, the full import protocol of the Ardour, REAPER and Ableton bridges, and the Ardour/REAPER render-and-upload protocol, all with the DAW APIs stubbed |
| Desktop app | Linux | `npm test` (React UI, Vitest: sign-in, songs, import, export, drag), `npm run build` (type-check), `cargo test` (built-in mock API) |

Run the same locally:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure   # Ardour/REAPER bridge tests need `lua` (apt install lua5.4)
cd apps/desktop && npm test && cd src-tauri && cargo test
```

To block merges that break the tests, protect `main` on GitHub (Settings > Branches): require a pull request and the CI status checks to pass.

### Ableton Live setup

1. Start the desktop app once - it copies `integrations/ableton/AI_DAW_Bridge` into Live's `User Library/Remote Scripts`.
2. Restart Live, then **Settings > Link, Tempo & MIDI > Control Surface** and pick **AI_DAW_Bridge** (no MIDI input/output needed).
3. The Ableton card shows `bridge ready`; **Import into Ableton Live** adds one track per stem at the playhead.

---

## Architecture

```text
React + TypeScript UI
        |
      Tauri
        |
    C++20 daw-agent
      /        \
 Music API      DAW adapters
(sign-in, songs,   |
 download, upload) Ardour / REAPER / Ableton bridges,
                   FL Studio / Logic Pro (drag only)
```

The C++ agent makes every API call (with the signed-in user's token) and talks to every DAW, so the UI never contains API- or DAW-specific code. The built-in mock API runs inside the desktop app; pointing the agent at a real backend that follows [schemas/api.md](schemas/api.md) needs no app changes.

---

# Ubuntu setup

## 1. System dependencies

You already need a C++ compiler, CMake and Node.js. For a fresh Ubuntu machine:

```bash
sudo apt update
sudo apt install -y build-essential cmake pkg-config libcurl4-openssl-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

Install Rust for Tauri if it is not installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

Check:

```bash
node --version
npm --version
cmake --version
g++ --version
rustc --version
cargo --version
```

---

## Building on macOS and Windows

- **macOS:** Xcode command line tools, CMake, Rust, Node, and `brew install boost`. curl comes with macOS.
- **Windows:** Visual Studio 2022 (C++ workload), CMake, Rust, Node, and [vcpkg](https://vcpkg.io): `vcpkg install curl:x64-windows-static boost-property-tree:x64-windows-static`, then configure with `-DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows-static`.

After building the agent, `./scripts/prepare-sidecar.sh` copies it to where Tauri bundles it from.

---

## 2. Build the C++ DAW agent

From the repository root:

```bash
cmake -S . -B build
cmake --build build -j
```

Test it:

```bash
./build/daw-agent health
```

You should receive JSON containing:

```json
{"ok":"true","service":"daw-agent"}
```

Check Ardour detection (Ardour is a [dev-mode](#daw-support) DAW, hence `AI_DAW_DEV=1`):

```bash
AI_DAW_DEV=1 ./build/daw-agent daws
```

The agent checks common locations including the official Ardour installer path under `/opt/Ardour-*`.

---

## 3. The API

The desktop app starts the built-in mock API on `http://127.0.0.1:8787` itself. To use the agent from a terminal, keep the app open (or point `--api` at a real backend), then sign in once - the password is read from the environment, never from the command line:

```bash
AI_DAW_PASSWORD=demo ./build/daw-agent login --email you@example.com
./build/daw-agent generate --prompt "dark techno"
```

The session is stored in `session.json` in the data folder, readable only by you. Downloaded songs are stored under:

```text
~/.local/share/ai-daw-prototype/generations/
```

---

# 4. Install the Ardour bridge (dev mode)

The prototype uses an Ardour **Editor Hook**. It watches a local request file written by the C++ agent and imports the referenced WAV files into the active session.

The desktop app installs the bridge script on every start of `npm run tauri dev`. Without the app, run:

```bash
AI_DAW_DEV=1 ./build/daw-agent install-bridges
```

It installs every DAW's bridge (Ardour into `~/.config/ardour9/scripts`) and writes this machine's bridge directory into each script.

Then:

1. Open **Ardour**.
2. Open or create a session.
3. Go to **Edit → Scripted Actions → Manage** (wording can vary slightly by Ardour build).
4. Open the **Editor Hooks / Callbacks** section.
5. Refresh the available scripts if needed.
6. Add/enable **AI DAW Import Bridge** for the session.
7. Keep that session open.

The hook writes a heartbeat here:

```text
~/.local/share/ai-daw-prototype/ardour/bridge.status
```

After a second or two, run:

```bash
AI_DAW_DEV=1 ./build/daw-agent daws
```

`bridge_ready` should now be `true`.

### Important prototype limitation

Ardour saves Editor Hooks with the session, so for this first prototype the bridge must be enabled in the session you want to receive generated audio. A later Ardour integration can make setup more automatic.

---

# 5. Run the desktop app

Open terminal 2:

```bash
cd apps/desktop
npm install
npm run tauri dev
```

The app should open as a native desktop window.

Workflow:

1. Sign in (built-in mock: any email, password `demo`).
2. Type a prompt and click **Generate**, or click **Open** on a song in **My songs**.
3. Open an Ardour session and enable the bridge; the app shows `bridge ready`.
4. Put Ardour's playhead where you want the song and click **Import into Ardour**. The bridge imports the stems at the playhead as separate tracks.
5. Mix, then bounce/export the mix from the DAW.
6. Click **Export mix to API** and pick the bounced file. It is uploaded to the song and listed under it.

---

# Running pieces separately

### C++ agent health

```bash
./build/daw-agent health
```

### Detect DAWs

```bash
./build/daw-agent daws
```

### Launch Ardour

```bash
AI_DAW_DEV=1 ./build/daw-agent launch --daw ardour
```

### Songs without the UI

```bash
AI_DAW_PASSWORD=demo ./build/daw-agent login --email you@example.com
./build/daw-agent songs
./build/daw-agent generate --prompt "Berlin warehouse techno"
./build/daw-agent download --song song-1
./build/daw-agent upload --song song-1 --file ~/Desktop/mix.wav
./build/daw-agent logout
```

`generate` and `download` print a `manifest_path`. Use it for a manual import test:

```bash
AI_DAW_DEV=1 ./build/daw-agent import --daw ardour --manifest /absolute/path/to/generation.json
```

---

# Where files live

```text
~/.local/share/ai-daw-prototype/
├── session.json            signed-in user's API token (owner-only)
├── generations/
│   └── song-.../
│       ├── drums.wav
│       ├── bass.wav
│       ├── synth.wav
│       ├── vocals.wav
│       └── generation.json
└── ardour/
    ├── bridge.status
    ├── import.request
    └── import.result
```

Generation files are deliberately persistent instead of temporary because DAW sessions can reference audio files after import.

---

# Current repository layout

```text
ai-daw-prototype/
├── apps/
│   └── desktop/               React + TypeScript + Tauri (+ built-in mock API)
├── native/
│   ├── agent/                 C++ command-line DAW agent
│   ├── core/                  shared native data types
│   ├── adapters/              DAW-specific native adapters
│   └── tests/                 C++ unit tests
├── integrations/              DAW bridges: ardour/, reaper/ (Lua), ableton/ (Python)
├── schemas/                   API contract (api.md) and manifest schema
├── tests/                     agent CLI + bridge protocol tests
├── CMakeLists.txt
└── README.md
```

---

# Why this structure

The UI never calls Ardour-specific functionality. It only asks the C++ agent to perform generic operations such as `generate`, `list DAWs` and `import generation`.

Future adapters can map the same conceptual operation differently:

```text
importGeneration()
   ├── ArdourAdapter  -> Lua / MCP
   ├── AbletonAdapter -> Live API bridge
   ├── ReaperAdapter  -> ReaScript or native extension
   └── FLAdapter      -> best supported FL integration path
```

The API likewise returns a generic generation manifest rather than DAW-specific data.

---

# Prototype caveats

- **Ardour import code needs to be validated on your exact Ardour 9.7 build.** Ardour's Lua API is powerful but explicitly subject to change. The supplied bridge uses documented/current Lua bindings and `Editor:do_embed`, but this is the first hardware/software integration point to test on your machine.
- The React/Tauri layer currently spawns the C++ agent per command. A production build can turn it into a persistent sidecar/daemon while keeping the same frontend command contract.
- The current Ardour bridge uses a file-based local handoff. This is deliberate for the first POC because it is simple and inspectable. Later we can replace it with a socket/MCP-style transport without changing the desktop app contract.
- Only Linux/Ardour has been exercised against a real DAW. The other adapters are written against each DAW's documented API but not yet run in it.
- The mock API returns immediately and keeps everything in memory until the app quits. A real generation API will likely use queued jobs plus WebSocket/SSE/polling progress.
- The API token is kept in a file only the user can read; production should move it into the OS keychain.
- Ableton Live, FL Studio and Logic Pro can't be told to render from outside, so their export uploads a file you bounced yourself. Ardour and REAPER (dev mode) render on request.
- No update system, crash recovery or project-owned media copying exists yet, and installers are unsigned.

---

# Next milestones

1. Validate Ardour 9.7 import on a real session.
2. Read Ardour project context (session name, BPM, playhead) into the UI through MCP.
3. Add import result/acknowledgement to the app instead of only queueing the request.
4. Add REAPER as the second adapter to validate that the abstraction is genuinely multi-DAW.
5. Add Ableton Live adapter.
6. Replace the fake generation API with the actual generation service.
7. Add generation progress, cancellation, previews and history.
8. Package the C++ agent as a proper Tauri sidecar for installers.
