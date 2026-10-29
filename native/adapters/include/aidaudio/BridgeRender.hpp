#pragma once
#include <chrono>
#include <filesystem>
#include <string>

namespace aidaudio {
// Asks a file-based bridge (Ardour, REAPER) to render the whole mix: writes
// render.request into `bridgeDir`, then blocks until the bridge answers in
// render.result or `timeout` passes. The bridge renders a WAV to exactly
// `file`, whose folder must already exist.
bool renderViaBridge(const std::filesystem::path& bridgeDir, const std::filesystem::path& file,
                     std::chrono::milliseconds timeout, std::string& error);
}
