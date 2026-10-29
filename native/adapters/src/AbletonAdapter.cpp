#include <aidaudio/AbletonAdapter.hpp>
#include <aidaudio/PlatformPaths.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

namespace aidaudio {

std::string AbletonAdapter::findExecutable() {
  // Edition and version (Suite/Standard/Intro, 11/12) are part of the
  // install name, so match by prefix. Ableton does not support Linux.
#if defined(_WIN32)
  const auto dir = paths::findPrefixed("C:/ProgramData/Ableton", "Live ");
  if (dir.empty()) return {};
  const auto exe = dir / "Program" / ("Ableton " + dir.filename().string() + ".exe");
  return fs::exists(exe) ? exe.string() : std::string{};
#elif defined(__APPLE__)
  // The .app bundle itself - launch() opens it through LaunchServices.
  return paths::findPrefixed("/Applications", "Ableton Live").string();
#else
  return {};
#endif
}

bool AbletonAdapter::processRunning() {
#if defined(__linux__)
  std::error_code ec;
  for (const auto& entry : fs::directory_iterator("/proc", ec)) {
    const auto n = entry.path().filename().string();
    if (n.empty() || !std::all_of(n.begin(), n.end(), ::isdigit)) continue;
    std::ifstream comm(entry.path() / "comm");
    std::string name;
    std::getline(comm, name);
    if (name.rfind("Live", 0) == 0) return true;
  }
  return false;
#elif defined(__APPLE__)
  // [^/] keeps the pattern from matching the `sh -c` running pgrep itself.
  return std::system("pgrep -f 'Ableton Live[^/]*\\.app/Contents/MacOS/' >/dev/null") == 0;
#else
  // Not implemented for this OS yet - unverified, always reports not running.
  return false;
#endif
}

bool AbletonAdapter::bridgeHeartbeatFresh() {
  const auto status = paths::bridgeDir("ableton") / "bridge.status";
  std::error_code ec;
  if (!fs::exists(status, ec)) return false;
  const auto mtime = fs::last_write_time(status, ec);
  if (ec) return false;
  const auto now = fs::file_time_type::clock::now();
  return now - mtime < std::chrono::seconds(4);
}

DawInfo AbletonAdapter::info() const {
  const auto exe = findExecutable();
  const bool bridgeReady = bridgeHeartbeatFresh();
  return DawInfo{
    .id = "ableton",
    .name = "Ableton Live",
    .installed = !exe.empty(),
    // A live heartbeat proves Live is running, including on Windows where
    // processRunning() has no implementation.
    .running = bridgeReady || processRunning(),
    .bridgeReady = bridgeReady,
    .executable = exe,
    .supportsAutoImport = true
  };
}

bool AbletonAdapter::launch() const {
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

bool AbletonAdapter::queueImport(const Generation& generation, std::string& error) const {
  auto state = info();
  if (!state.running) {
    error = "Ableton Live is not running. Open Live first.";
    return false;
  }
  if (!state.bridgeReady) {
    error = "Live is running, but the Gaslab_DAW_Plugin control surface is not active "
            "(needs Live 12.0.5+; select it once under Settings > Link, Tempo & MIDI > Control Surface).";
    return false;
  }
  if (generation.assets.empty()) {
    error = "Generation contains no assets.";
    return false;
  }

  const auto dir = paths::bridgeDir("ableton");
  std::error_code ec;
  fs::create_directories(dir, ec);
  if (ec) {
    error = "Could not create Ableton bridge directory: " + ec.message();
    return false;
  }

  const auto tmp = dir / "import.request.tmp";
  const auto dst = dir / "import.request";
  {
    std::ofstream out(tmp, std::ios::trunc);
    if (!out) {
      error = "Could not write Ableton import request.";
      return false;
    }
    out << "version=1\n";
    out << "generation_id=" << generation.id << "\n";
    out << "title=" << generation.title << "\n";
    out << "placement=playhead\n";
    for (const auto& asset : generation.assets) {
      if (!fs::exists(asset.localPath)) {
        error = "Missing downloaded asset: " + asset.localPath.string();
        return false;
      }
      out << "asset=" << asset.name << "\t" << fs::absolute(asset.localPath).string() << "\n";
    }
  }
  fs::rename(tmp, dst, ec);
  if (ec) {
    fs::remove(dst, ec);
    ec.clear();
    fs::rename(tmp, dst, ec);
  }
  if (ec) {
    error = "Could not publish Ableton import request: " + ec.message();
    return false;
  }
  return true;
}
}
