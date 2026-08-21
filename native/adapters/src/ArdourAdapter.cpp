#include <aidaudio/ArdourAdapter.hpp>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <thread>
#include <unistd.h>

namespace fs = std::filesystem;

namespace {
fs::path homeDir() {
  if (const char* home = std::getenv("HOME")) return fs::path(home);
  return fs::temp_directory_path();
}

bool executableFile(const fs::path& p) {
  return fs::exists(p) && !fs::is_directory(p) && ::access(p.c_str(), X_OK) == 0;
}
}

namespace aidaudio {
fs::path ArdourAdapter::bridgeDir() {
  return homeDir() / ".local" / "share" / "ai-daw-prototype" / "ardour";
}

std::string ArdourAdapter::findExecutable() {
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
}

bool ArdourAdapter::processRunning() {
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
  return DawInfo{
    .id = "ardour",
    .name = "Ardour",
    .installed = !exe.empty(),
    .running = processRunning(),
    .bridgeReady = bridgeHeartbeatFresh(),
    .executable = exe
  };
}

bool ArdourAdapter::launch() const {
  auto exe = findExecutable();
  if (exe.empty()) return false;
  if (processRunning()) return true;
  const std::string command = "\"" + exe + "\" >/dev/null 2>&1 &";
  return std::system(command.c_str()) == 0;
}

bool ArdourAdapter::queueImport(const Generation& generation, std::string& error) const {
  auto state = info();
  if (!state.running) {
    error = "Ardour is not running. Open Ardour and a session first.";
    return false;
  }
  if (!state.bridgeReady) {
    error = "Ardour is running, but the AI DAW Import Bridge Lua hook is not active in this session.";
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
}
