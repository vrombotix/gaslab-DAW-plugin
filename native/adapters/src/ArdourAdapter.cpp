#include <aidaudio/ArdourAdapter.hpp>
#include <aidaudio/BridgeRender.hpp>
#include <aidaudio/PlatformPaths.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

#if defined(__linux__)
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace {
#if defined(__linux__)
bool executableFile(const fs::path& p) {
  return fs::exists(p) && !fs::is_directory(p) && ::access(p.c_str(), X_OK) == 0;
}
#endif
}

namespace aidaudio {
fs::path ArdourAdapter::bridgeDir() {
  return paths::bridgeDir("ardour");
}

std::string ArdourAdapter::findExecutable() {
#if defined(__linux__)
  const std::vector<fs::path> common = {
    "/opt/Ardour-9.7.0/bin/ardour9",
    "/opt/Ardour-9.7.0/bin/ardour9.7.0",
    "/usr/bin/ardour9",
    "/usr/local/bin/ardour9",
    "/usr/bin/ardour"
  };
  for (const auto& p : common) if (executableFile(p)) return p.string();

  std::error_code ec;
  if (fs::exists("/opt", ec)) {
    for (const auto& entry : fs::directory_iterator("/opt", ec)) {
      if (!entry.is_directory()) continue;
      const auto name = entry.path().filename().string();
      if (name.rfind("Ardour-", 0) != 0) continue;
      for (const char* candidate : {"ardour9", "ardour"}) {
        auto p = entry.path() / "bin" / candidate;
        if (executableFile(p)) return p.string();
      }
    }
  }

  if (const char* path = std::getenv("PATH")) {
    std::stringstream ss(path);
    std::string part;
    while (std::getline(ss, part, ':')) {
      for (const char* candidate : {"ardour9", "ardour"}) {
        auto p = fs::path(part) / candidate;
        if (executableFile(p)) return p.string();
      }
    }
  }
  return {};
#elif defined(__APPLE__)
  // The .app bundle itself ("Ardour9.app") - launch() opens it through LaunchServices.
  return paths::findPrefixed("/Applications", "Ardour").string();
#else
  // Windows install layout not confirmed yet - imports still work once the
  // bridge heartbeat is live, only "installed"/launch are unavailable.
  return {};
#endif
}

bool ArdourAdapter::processRunning() {
#if defined(__linux__)
  std::error_code ec;
  for (const auto& entry : fs::directory_iterator("/proc", ec)) {
    const auto n = entry.path().filename().string();
    if (n.empty() || !std::all_of(n.begin(), n.end(), ::isdigit)) continue;
    std::ifstream comm(entry.path() / "comm");
    std::string name;
    std::getline(comm, name);
    if (name.rfind("ardour", 0) == 0 || name.rfind("Ardour", 0) == 0) return true;
  }
  return false;
#elif defined(__APPLE__)
  // [^/] keeps the pattern from matching the `sh -c` running pgrep itself.
  return std::system("pgrep -f 'Ardour[^/]*\\.app/Contents/MacOS/' >/dev/null") == 0;
#else
  return false;
#endif
}

bool ArdourAdapter::bridgeHeartbeatFresh() {
  const auto status = bridgeDir() / "bridge.status";
  std::error_code ec;
  if (!fs::exists(status, ec)) return false;
  const auto mtime = fs::last_write_time(status, ec);
  if (ec) return false;
  const auto now = fs::file_time_type::clock::now();
  return now - mtime < std::chrono::seconds(4);
}

DawInfo ArdourAdapter::info() const {
  const auto exe = findExecutable();
  const bool bridgeReady = bridgeHeartbeatFresh();
  return DawInfo{
    .id = "ardour",
    .name = "Ardour",
    .installed = !exe.empty(),
    // A live heartbeat proves Ardour is running, including on Windows where
    // processRunning() has no implementation.
    .running = bridgeReady || processRunning(),
    .bridgeReady = bridgeReady,
    .executable = exe,
    .supportsRender = true
  };
}

bool ArdourAdapter::launch() const {
  auto exe = findExecutable();
  if (exe.empty()) return false;
  if (processRunning()) return true;
#if defined(__APPLE__)
  const std::string command = "open \"" + exe + "\"";
#else
  const std::string command = "\"" + exe + "\" >/dev/null 2>&1 &";
#endif
  return std::system(command.c_str()) == 0;
}

bool ArdourAdapter::queueImport(const Generation& generation, std::string& error) const {
  auto state = info();
  if (!state.running) {
    error = "Ardour is not running. Open Ardour and a session first.";
    return false;
  }
  if (!state.bridgeReady) {
    error = "Ardour is running, but the Gaslab DAW Plugin hook is not active in this session "
            "(Edit > Lua Scripts > Script Manager > Action Hooks > New Hook).";
    return false;
  }
  if (generation.assets.empty()) {
    error = "Generation contains no assets.";
    return false;
  }

  const auto dir = bridgeDir();
  std::error_code ec;
  fs::create_directories(dir, ec);
  if (ec) {
    error = "Could not create Ardour bridge directory: " + ec.message();
    return false;
  }

  const auto tmp = dir / "import.request.tmp";
  const auto dst = dir / "import.request";
  {
    std::ofstream out(tmp, std::ios::trunc);
    if (!out) {
      error = "Could not write Ardour import request.";
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
    error = "Could not publish Ardour import request: " + ec.message();
    return false;
  }
  return true;
}

bool ArdourAdapter::renderMix(const fs::path& file, std::string& error) const {
  if (!bridgeHeartbeatFresh()) {
    error = "Ardour's bridge is not running.";
    return false;
  }
  // Renders can take minutes for long sessions, and the bridge is silent while the DAW renders.
  return renderViaBridge(bridgeDir(), file, std::chrono::minutes(15), error);
}
}
