# AI DAW Prototype v0.1

A first end-to-end prototype for a **standalone AI music generation app that can hand generated stems directly to multiple DAWs**.

The current prototype implements the shared architecture and the first DAW adapter: **Ardour 9.x on Linux**.

## What works in v0.1

1. React + TypeScript desktop UI.
2. Tauri 2 desktop shell.
3. C++20 native `daw-agent`.
4. A real local HTTP mock generation API.
5. The API returns four fixed WAV stems: Drums, Bass, Synth and Vocals.
6. The C++ agent downloads those files into a persistent local generation folder.
7. Ardour detection and launch support.
8. Ardour Lua bridge heartbeat/detection.
9. Clicking **Import all stems into Ardour** queues all four files for the active Ardour session at the current playhead.

The Ardour import bridge is intentionally isolated behind an adapter so Ableton, REAPER, FL Studio etc. can be added without changing the generation UI or cloud API.

---

## Architecture

```text
React + TypeScript UI
        |
      Tauri
        |
    C++20 daw-agent
      /        \
Mock AI API     DAW adapters
                   |
                 Ardour
               Lua bridge
```

The mock API is a separate process on purpose. The C++ agent performs actual HTTP requests and downloads, so replacing the mock API with the real generation platform later does not require changing the desktop architecture.

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

## Quick smoke test

Before setting up the GUI or Ardour integration, you can validate the mock API + C++ chain with:

```bash
./scripts/smoke-test.sh
```

This builds the agent, temporarily starts the dependency-free mock API, performs a fake generation, downloads all four stems, then shuts the mock API down.

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

Check Ardour detection:

```bash
./build/daw-agent daws
```

The agent checks common locations including the official Ardour installer path under `/opt/Ardour-*`.

---

## 3. Start the fake AI API

Open terminal 1:

```bash
cd mock-api
npm install
npm run dev
```

You should see:

```text
Mock AI API listening on http://127.0.0.1:8787
```

The API does not generate music yet. Every request returns the four WAV files in `mock-api/assets/`.

You can test the full native generation path before opening the UI:

```bash
./build/daw-agent generate --prompt "dark techno"
```

Downloaded generations are stored under:

```text
~/.local/share/ai-daw-prototype/generations/
```

---

# 4. Install the Ardour bridge

The prototype uses an Ardour **Editor Hook**. It watches a local request file written by the C++ agent and imports the referenced WAV files into the active session.

Install the supplied bridge script with:

```bash
./scripts/install-ardour-bridge.sh
```

The helper installs it into both `~/.config/ardour8/scripts` and `~/.config/ardour9/scripts` because the exact user-data directory can differ by Ardour packaging/version.

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
./build/daw-agent daws
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

1. Make sure the mock API is running.
2. Open an Ardour session and enable the bridge.
3. Type any prompt.
4. Click **Generate**.
5. Four fixed demo stems are downloaded by the C++ agent.
6. Ardour should show `running` and `bridge ready` in the app.
7. Put Ardour's playhead where you want the generation.
8. Click **Import all stems into Ardour**.
9. The bridge imports the four WAV files at the playhead as separate tracks.

---

# Running pieces separately

### Fake API

```bash
cd mock-api
npm run dev
```

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
./build/daw-agent launch --daw ardour
```

### Fake generation without the UI

```bash
./build/daw-agent generate --prompt "Berlin warehouse techno"
```

The response contains a `manifest_path`. Use that path for a manual import test:

```bash
./build/daw-agent import --daw ardour --manifest /absolute/path/to/generation.json
```

---

# Where files live

```text
~/.local/share/ai-daw-prototype/
├── generations/
│   └── demo-.../
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
│   └── desktop/               React + TypeScript + Tauri
├── native/
│   ├── agent/                 C++ command-line DAW agent
│   ├── core/                  shared native data types
│   └── adapters/              DAW-specific native adapters
├── integrations/
│   └── ardour/                Ardour Lua bridge
├── mock-api/                  TypeScript fake AI API
│   └── assets/                fixed demo WAV stems
├── schemas/                   shared protocol schemas
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
- Only Linux/Ardour is implemented in v0.1. The C++ interface is already split so the next adapter does not require a frontend rewrite.
- The mock API returns immediately. A real generation API will likely use queued jobs plus WebSocket/SSE/polling progress.
- No authentication, update system, crash recovery, project-owned media copying, or production installer exists yet.

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
