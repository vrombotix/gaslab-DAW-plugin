#include <aidaudio/PlatformPaths.hpp>
#include <cstdlib>

namespace fs = std::filesystem;

namespace {
const char* env(const char* name) { return std::getenv(name); }
}

namespace aidaudio::paths {

std::filesystem::path homeDir() {
#if defined(_WIN32)
  if (const char* profile = env("USERPROFILE")) return fs::path(profile);
  const char* drive = env("HOMEDRIVE");
  const char* path = env("HOMEPATH");
  if (drive && path) return fs::path(drive) / path;
#else
  if (const char* home = env("HOME")) return fs::path(home);
#endif
  return fs::temp_directory_path();
}

std::filesystem::path appDataDir() {
#if defined(_WIN32)
  // Unverified: Windows convention, not exercised against a real install.
  if (const char* appdata = env("APPDATA")) return fs::path(appdata) / "ai-daw-prototype";
  return homeDir() / "AppData" / "Roaming" / "ai-daw-prototype";
#elif defined(__APPLE__)
  // Unverified: macOS convention, not exercised against a real install.
  return homeDir() / "Library" / "Application Support" / "ai-daw-prototype";
#else
  return homeDir() / ".local" / "share" / "ai-daw-prototype";
#endif
}

std::filesystem::path bridgeDir(const std::string& daw) {
  return appDataDir() / daw;
}

std::filesystem::path executableDir() {
#if defined(_WIN32)
  // Unverified: Windows would need GetModuleFileNameW here.
  return fs::current_path();
#elif defined(__APPLE__)
  // Unverified: macOS would need _NSGetExecutablePath here.
  return fs::current_path();
#else
  std::error_code ec;
  auto exe = fs::read_symlink("/proc/self/exe", ec);
  if (ec) return fs::current_path();
  return exe.parent_path();
#endif
}

std::filesystem::path integrationsDir() {
  if (const char* override_dir = env("AI_DAW_INTEGRATIONS_DIR")) return fs::path(override_dir);
  return executableDir() / ".." / "integrations";
}

std::filesystem::path ardourScriptsDir() {
  // Ardour keeps per-major-version config directories (ardour8, ardour9, ...).
  // This targets the version this prototype was built/tested against; an
  // installer should also try older major versions as a fallback.
#if defined(_WIN32)
  // Ardour keeps its config under Local, not Roaming, AppData (Ardour manual,
  // "Lua Scripting": %localappdata%\ardourN\scripts).
  if (const char* local = env("LOCALAPPDATA")) return fs::path(local) / "ardour9" / "scripts";
  return homeDir() / "AppData" / "Local" / "ardour9" / "scripts";
#elif defined(__APPLE__)
  return homeDir() / "Library" / "Preferences" / "Ardour9" / "scripts";
#else
  return homeDir() / ".config" / "ardour9" / "scripts";
#endif
}

std::filesystem::path reaperScriptsDir() {
#if defined(_WIN32)
  if (const char* appdata = env("APPDATA")) return fs::path(appdata) / "REAPER" / "Scripts";
  return homeDir() / "AppData" / "Roaming" / "REAPER" / "Scripts";
#elif defined(__APPLE__)
  return homeDir() / "Library" / "Application Support" / "REAPER" / "Scripts";
#else
  return homeDir() / ".config" / "REAPER" / "Scripts";
#endif
}

std::filesystem::path abletonRemoteScriptsDir() {
  // Ableton Live does not officially support Linux; the Linux branch below
  // is an untested best guess mirroring the macOS/Windows layout.
#if defined(_WIN32)
  return homeDir() / "Documents" / "Ableton" / "User Library" / "Remote Scripts";
#else
  return homeDir() / "Music" / "Ableton" / "User Library" / "Remote Scripts";
#endif
}

std::filesystem::path findPrefixed(const std::filesystem::path& dir, const std::string& prefix) {
  std::error_code ec;
  for (const auto& entry : fs::directory_iterator(dir, ec)) {
    if (entry.path().filename().string().rfind(prefix, 0) == 0) return entry.path();
  }
  return {};
}

}
