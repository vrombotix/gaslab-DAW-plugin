#pragma once
#include <filesystem>
#include <string>

namespace aidaudio::paths {

// The current user's home directory (Linux/macOS: $HOME, Windows: %USERPROFILE%).
std::filesystem::path homeDir();

// Where this app stores generations and DAW bridge state:
//   Linux:   ~/.local/share/ai-daw-prototype
//   macOS:   ~/Library/Application Support/ai-daw-prototype
//   Windows: %APPDATA%/ai-daw-prototype
// The macOS/Windows branches are best-effort and unverified on real hardware.
std::filesystem::path appDataDir();

// Per-DAW bridge state directory, i.e. appDataDir() / daw.
std::filesystem::path bridgeDir(const std::string& daw);

// Directory containing the running daw-agent executable itself.
// Linux-verified (via /proc/self/exe); macOS/Windows branches are
// best-effort and unverified.
std::filesystem::path executableDir();

// Where the installer/first-run bridge-script installer reads the source
// scripts from. Defaults to executableDir()/../integrations (matches this
// repo's build/daw-agent -> ../integrations layout), overridable via the
// AI_DAW_INTEGRATIONS_DIR env var for a packaged build whose bundled
// resource layout differs.
std::filesystem::path integrationsDir();

// Where each DAW's own scripting engine loads user scripts from, so an
// installer can drop the matching bridge script into the right place.
// Best-effort / unverified for anything other than the Linux Ardour path,
// which is the only one exercised against a real install so far.
std::filesystem::path ardourScriptsDir();
std::filesystem::path reaperScriptsDir();
std::filesystem::path abletonRemoteScriptsDir();

// First entry in `dir` whose name starts with `prefix`, or empty. For
// install folders that carry version/edition in their name, e.g.
// ("/Applications", "Ableton Live") -> "/Applications/Ableton Live 12 Suite.app".
std::filesystem::path findPrefixed(const std::filesystem::path& dir, const std::string& prefix);

}
