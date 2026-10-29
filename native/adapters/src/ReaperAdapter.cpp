#include <aidaudio/BridgeRender.hpp>
#include <aidaudio/PlatformPaths.hpp>
#include <aidaudio/ReaperAdapter.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

#if !defined(_WIN32)
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace {
bool executableFile(const fs::path& p) {
#if defined(_WIN32)
  return fs::exists(p) && !fs::is_directory(p);
#else
  return fs::exists(p) && !fs::is_directory(p) && ::access(p.c_str(), X_OK) == 0;
#endif
}
}

namespace aidaudio {

std::string ReaperAdapter::findExecutable() {
#if defined(__APPLE__)
  // The .app bundle itself (REAPER.app, or REAPER64.app on older installs) -
  // launch() opens it through LaunchServices.
  return paths::findPrefixed("/Applications", "REAPER").string();
#else
  const std::vector<fs::path> common = {
#if defined(_WIN32)
    "C:/Program Files/REAPER (x64)/reaper.exe",
    "C:/Program Files (x86)/REAPER/reaper.exe",
#else
    "/opt/REAPER/reaper",
    "/usr/bin/reaper",
    "/usr/local/bin/reaper",
#endif
  };
  for (const auto& p : common) if (executableFile(p)) return p.string();

  if (const char* path = std::getenv("PATH")) {
    std::stringstream ss(path);
    std::string part;
#if defined(_WIN32)
    const char sep = ';';
#else
    const char sep = ':';
#endif
    while (std::getline(ss, part, sep)) {
#if defined(_WIN32)
      auto p = fs::path(part) / "reaper.exe";
#else
      auto p = fs::path(part) / "reaper";
#endif
      if (executableFile(p)) return p.string();
    }
  }
  return {};
#endif
}

bool ReaperAdapter::processRunning() {
#if defined(__APPLE__)
  // [^/] keeps the pattern from matching the `sh -c` running pgrep itself.
  return std::system("pgrep -f 'REAPER[^/]*\\.app/Contents/MacOS/' >/dev/null") == 0;
#elif defined(_WIN32)
  // Not implemented yet - info() falls back to the bridge heartbeat.
  return false;
#else
  std::error_code ec;
  for (const auto& entry : fs::directory_iterator("/proc", ec)) {
    const auto n = entry.path().filename().string();
    if (n.empty() || !std::all_of(n.begin(), n.end(), ::isdigit)) continue;
    std::ifstream comm(entry.path() / "comm");
    std::string name;
    std::getline(comm, name);
    if (name.rfind("reaper", 0) == 0) return true;
  }
  return false;
#endif
}

bool ReaperAdapter::bridgeHeartbeatFresh() {
  const auto status = paths::bridgeDir("reaper") / "bridge.status";
  std::error_code ec;
  if (!fs::exists(status, ec)) return false;
  const auto mtime = fs::last_write_time(status, ec);
  if (ec) return false;
  const auto now = fs::file_time_type::clock::now();
  return now - mtime < std::chrono::seconds(4);
}

DawInfo ReaperAdapter::info() const {
  const auto exe = findExecutable();
  const bool bridgeReady = bridgeHeartbeatFresh();
  return DawInfo{
    .id = "reaper",
    .name = "REAPER",
    .installed = !exe.empty(),
    // A live heartbeat proves REAPER is running, including on Windows where
    // processRunning() has no implementation.
    .running = bridgeReady || processRunning(),
    .bridgeReady = bridgeReady,
    .executable = exe,
    .supportsAutoImport = true,
    .supportsRender = true
  };
}

bool ReaperAdapter::launch() const {
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

bool ReaperAdapter::queueImport(const Generation& generation, std::string& error) const {
  auto state = info();
  if (!state.running) {
    error = "REAPER is not running. Open REAPER first.";
    return false;
  }
  if (!state.bridgeReady) {
    error = "REAPER is running, but the AI DAW Import Bridge script is not active "
            "(start the AI DAW app once so it installs the bridge, then restart REAPER).";
    return false;
  }
  if (generation.assets.empty()) {
    error = "Generation contains no assets.";
    return false;
  }

  const auto dir = paths::bridgeDir("reaper");
  std::error_code ec;
  fs::create_directories(dir, ec);
  if (ec) {
    error = "Could not create REAPER bridge directory: " + ec.message();
    return false;
  }

  const auto tmp = dir / "import.request.tmp";
  const auto dst = dir / "import.request";
  {
    std::ofstream out(tmp, std::ios::trunc);
    if (!out) {
      error = "Could not write REAPER import request.";
      return false;
    }
    out << "version=1\n";
    out << "generation_id=" << generation.id << "\n";
    out << "title=" << generation.title << "\n";
    out << "placement=cursor\n";
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
    error = "Could not publish REAPER import request: " + ec.message();
    return false;
  }
  return true;
}

bool ReaperAdapter::renderMix(const fs::path& file, std::string& error) const {
  if (!bridgeHeartbeatFresh()) {
    error = "REAPER's bridge is not running.";
    return false;
  }
  // Renders can take minutes for long sessions, and the bridge is silent while the DAW renders.
  return renderViaBridge(paths::bridgeDir("reaper"), file, std::chrono::minutes(15), error);
}
}
