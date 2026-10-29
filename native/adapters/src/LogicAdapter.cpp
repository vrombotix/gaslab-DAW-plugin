#include <aidaudio/LogicAdapter.hpp>
#include <aidaudio/PlatformPaths.hpp>
#include <cstdlib>

namespace aidaudio {

std::string LogicAdapter::findExecutable() {
  // "Logic Pro.app" since 10.8, "Logic Pro X.app" before. Returns the .app
  // bundle - launch() opens it through LaunchServices. Always empty off macOS.
  return paths::findPrefixed("/Applications", "Logic Pro").string();
}

bool LogicAdapter::processRunning() {
#if defined(__APPLE__)
  // [^/] keeps the pattern from matching the `sh -c` running pgrep itself.
  return std::system("pgrep -f 'Logic Pro[^/]*\\.app/Contents/MacOS/' >/dev/null") == 0;
#else
  return false;
#endif
}

DawInfo LogicAdapter::info() const {
  const auto exe = findExecutable();
  return DawInfo{
    .id = "logic",
    .name = "Logic Pro",
    .installed = !exe.empty(),
    .running = processRunning(),
    .executable = exe,
    .supportsAutoImport = false
  };
}

bool LogicAdapter::launch() const {
  const auto exe = findExecutable();
  if (exe.empty()) return false;
  // `open` just focuses Logic if it is already running.
  return std::system(("open \"" + exe + "\"").c_str()) == 0;
}

bool LogicAdapter::queueImport(const Generation&, std::string& error) const {
  error = "Logic Pro has no scripting call to import audio. "
          "Drag the stems from the app into Logic's Tracks area.";
  return false;
}
}
