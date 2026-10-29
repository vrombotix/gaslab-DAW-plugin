#include <aidaudio/FLStudioAdapter.hpp>
#include <aidaudio/PlatformPaths.hpp>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

namespace aidaudio {

std::string FLStudioAdapter::findExecutable() {
  // The version is part of the install name ("FL Studio 21", "FL Studio
  // 2024"), so match by prefix. FL Studio does not support Linux.
#if defined(_WIN32)
  const auto exe = paths::findPrefixed("C:/Program Files/Image-Line", "FL Studio") / "FL64.exe";
  return fs::exists(exe) ? exe.string() : std::string{};
#elif defined(__APPLE__)
  // The .app bundle itself - launch() opens it through LaunchServices.
  return paths::findPrefixed("/Applications", "FL Studio").string();
#else
  return {};
#endif
}

bool FLStudioAdapter::processRunning() {
#if defined(__linux__)
  std::error_code ec;
  for (const auto& entry : fs::directory_iterator("/proc", ec)) {
    const auto n = entry.path().filename().string();
    if (n.empty() || !std::all_of(n.begin(), n.end(), ::isdigit)) continue;
    std::ifstream comm(entry.path() / "comm");
    std::string name;
    std::getline(comm, name);
    if (name.rfind("FL64", 0) == 0 || name.rfind("FLStudio", 0) == 0) return true;
  }
  return false;
#elif defined(__APPLE__)
  // [^/] keeps the pattern from matching the `sh -c` running pgrep itself.
  return std::system("pgrep -f 'FL Studio[^/]*\\.app/Contents/MacOS/' >/dev/null") == 0;
#else
  // Not implemented for this OS yet - unverified, always reports not running.
  return false;
#endif
}

DawInfo FLStudioAdapter::info() const {
  const auto exe = findExecutable();
  return DawInfo{
    .id = "flstudio",
    .name = "FL Studio",
    .installed = !exe.empty(),
    .running = processRunning(),
    .executable = exe,
    .supportsAutoImport = false
  };
}

bool FLStudioAdapter::launch() const {
  auto exe = findExecutable();
  if (exe.empty()) return false;
  if (processRunning()) return true;
#if defined(_WIN32)
  const std::string command = "start \"\" \"" + exe + "\"";
#elif defined(__APPLE__)
  const std::string command = "open \"" + exe + "\"";
#else
  const std::string command = "\"" + exe + "\" >/dev/null 2>&1 &";
#endif
  return std::system(command.c_str()) == 0;
}

bool FLStudioAdapter::queueImport(const Generation&, std::string& error) const {
  error = "FL Studio has no scripting call to import audio. "
          "Drag the stems from the app into FL Studio's Playlist.";
  return false;
}
}
