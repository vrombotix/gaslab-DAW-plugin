// Unit tests for the DAW adapters and platform helpers, run by ctest.
// Every test points HOME/USERPROFILE/APPDATA at a fresh temp directory, so
// nothing touches the real user's data or DAW config.
#include <aidaudio/AbletonAdapter.hpp>
#include <aidaudio/ArdourAdapter.hpp>
#include <aidaudio/BridgeRender.hpp>
#include <aidaudio/FLStudioAdapter.hpp>
#include <aidaudio/LogicAdapter.hpp>
#include <aidaudio/PlatformPaths.hpp>
#include <aidaudio/ReaperAdapter.hpp>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>

namespace fs = std::filesystem;
using namespace aidaudio;

namespace {
int failures = 0;

#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond "\n"; \
      ++failures;                                                                \
    }                                                                            \
  } while (0)

void setEnv(const char* name, const std::string& value) {
#if defined(_WIN32)
  _putenv_s(name, value.c_str());
#else
  setenv(name, value.c_str(), 1);
#endif
}

fs::path freshHome() {
  const auto home = fs::temp_directory_path() / "aidaudio-tests-home";
  fs::remove_all(home);
  fs::create_directories(home);
  setEnv("HOME", home.string());
  setEnv("USERPROFILE", home.string());
  setEnv("APPDATA", (home / "AppData").string());
  setEnv("LOCALAPPDATA", (home / "AppData" / "Local").string());
  return home;
}

std::string readFile(const fs::path& path) {
  std::ifstream in(path);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

bool contains(const std::string& haystack, const std::string& needle) {
  return haystack.find(needle) != std::string::npos;
}

void writeHeartbeat(const std::string& daw) {
  const auto dir = paths::bridgeDir(daw);
  fs::create_directories(dir);
  std::ofstream(dir / "bridge.status") << "ready\n";
}

Generation sampleGeneration(const fs::path& home) {
  Generation g;
  g.id = "gen-1";
  g.title = "Test Generation";
  for (const char* name : {"Drums", "Bass"}) {
    Asset a;
    a.role = name;
    a.name = name;
    a.localPath = home / (std::string(name) + ".wav");
    std::ofstream(a.localPath) << "RIFF";
    g.assets.push_back(a);
  }
  return g;
}

void testFindPrefixed() {
  const auto home = freshHome();
  fs::create_directories(home / "Apps" / "Ableton Live 12 Suite.app");
  fs::create_directories(home / "Apps" / "Other.app");
  CHECK(paths::findPrefixed(home / "Apps", "Ableton Live") == home / "Apps" / "Ableton Live 12 Suite.app");
  CHECK(paths::findPrefixed(home / "Apps", "Logic Pro").empty());
  CHECK(paths::findPrefixed(home / "missing", "Ableton Live").empty());
}

void testBridgeDirLivesUnderHome() {
  const auto home = freshHome();
  const auto dir = paths::bridgeDir("ableton");
  CHECK(dir.filename() == "ableton");
  CHECK(dir.parent_path().filename() == "ai-daw-prototype");
  CHECK(dir.string().rfind(home.string(), 0) == 0);
}

// Ardour, REAPER and Ableton share the file-based bridge protocol.
void testBridgeAdapter(const IDawAdapter& adapter, const std::string& id) {
  std::cerr << "  bridge adapter: " << id << "\n";
  auto home = freshHome();
  auto g = sampleGeneration(home);
  std::string error;

  CHECK(adapter.info().id == id);
  CHECK(adapter.info().supportsAutoImport);
  CHECK(adapter.info().supportsRender == (id != "ableton"));  // Ableton's LOM can't render
  CHECK(!adapter.info().bridgeReady);
  CHECK(!adapter.queueImport(g, error));
  CHECK(!error.empty());
  CHECK(!fs::exists(paths::bridgeDir(id) / "import.request"));

  writeHeartbeat(id);
  CHECK(adapter.info().bridgeReady);
  CHECK(adapter.info().running);  // a live heartbeat implies the DAW runs

  error.clear();
  CHECK(adapter.queueImport(g, error));
  CHECK(error.empty());
  const auto request = readFile(paths::bridgeDir(id) / "import.request");
  CHECK(contains(request, "version=1\n"));
  CHECK(contains(request, "generation_id=gen-1\n"));
  const auto drums = request.find("asset=Drums\t" + fs::absolute(g.assets[0].localPath).string() + "\n");
  const auto bass = request.find("asset=Bass\t" + fs::absolute(g.assets[1].localPath).string() + "\n");
  CHECK(drums != std::string::npos && bass != std::string::npos && drums < bass);
  CHECK(!fs::exists(paths::bridgeDir(id) / "import.request.tmp"));

  fs::remove(g.assets[1].localPath);
  CHECK(!adapter.queueImport(g, error));
  CHECK(contains(error, "Missing downloaded asset"));

  g.assets.clear();
  CHECK(!adapter.queueImport(g, error));

  // The bridges rewrite the heartbeat every second; 10 s old means it is gone.
  const auto status = paths::bridgeDir(id) / "bridge.status";
  fs::last_write_time(status, fs::file_time_type::clock::now() - std::chrono::seconds(10));
  CHECK(!adapter.info().bridgeReady);
}

// Plays the bridge side of one render: waits for render.request, then writes
// the mixdown (unless `status` is an error) and an atomic render.result.
std::thread fakeRenderBridge(const fs::path& dir, const std::string& status) {
  return std::thread([dir, status] {
    for (int i = 0; i < 250 && !fs::exists(dir / "render.request"); ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    std::ifstream in(dir / "render.request");
    std::string line, id, folder, name;
    while (std::getline(in, line)) {
      const auto eq = line.find('=');
      const auto key = line.substr(0, eq), value = line.substr(eq + 1);
      if (key == "request_id") id = value;
      if (key == "folder") folder = value;
      if (key == "name") name = value;
    }
    in.close();
    fs::remove(dir / "render.request");
    const auto file = fs::path(folder) / (name + ".wav");
    if (status == "ok") std::ofstream(file) << "RIFF";
    std::ofstream(dir / "render.result.tmp") << id << "\n" << status << "\n" << (status == "ok" ? file.string() : "stub render failed") << "\n";
    fs::rename(dir / "render.result.tmp", dir / "render.result");
  });
}

void testRenderViaBridge() {
  const auto home = freshHome();
  const auto dir = home / "bridge";
  const auto file = home / "renders" / "mix.wav";
  fs::create_directories(dir);
  fs::create_directories(file.parent_path());
  std::string error;

  std::ofstream(dir / "render.result") << "an-older-request\nok\nstale.wav\n";  // must be ignored
  auto bridge = fakeRenderBridge(dir, "ok");
  CHECK(renderViaBridge(dir, file, std::chrono::seconds(10), error));
  bridge.join();
  CHECK(error.empty());
  CHECK(readFile(file) == "RIFF");

  bridge = fakeRenderBridge(dir, "error");
  CHECK(!renderViaBridge(dir, home / "renders" / "mix2.wav", std::chrono::seconds(10), error));
  bridge.join();
  CHECK(error == "stub render failed");

  // No bridge answering: give up and withdraw the request.
  CHECK(!renderViaBridge(dir, home / "renders" / "mix3.wav", std::chrono::milliseconds(300), error));
  CHECK(contains(error, "Timed out"));
  CHECK(!fs::exists(dir / "render.request"));
}

// FL Studio and Logic Pro have no import API: they must never claim success
// or leave request files behind.
void testDragOnlyAdapter(const IDawAdapter& adapter, const std::string& id) {
  std::cerr << "  drag-only adapter: " << id << "\n";
  const auto home = freshHome();
  const auto g = sampleGeneration(home);
  std::string error;

  const auto info = adapter.info();
  CHECK(info.id == id);
  CHECK(!info.supportsAutoImport);
  CHECK(!info.supportsRender);
  CHECK(!info.bridgeReady);
  CHECK(!adapter.queueImport(g, error));
  CHECK(contains(error, "Drag"));
  CHECK(!fs::exists(paths::bridgeDir(id)));
}
}

int main() {
  testFindPrefixed();
  testBridgeDirLivesUnderHome();
  testBridgeAdapter(ArdourAdapter{}, "ardour");
  testBridgeAdapter(ReaperAdapter{}, "reaper");
  testBridgeAdapter(AbletonAdapter{}, "ableton");
  testDragOnlyAdapter(FLStudioAdapter{}, "flstudio");
  testDragOnlyAdapter(LogicAdapter{}, "logic");
  testRenderViaBridge();

  fs::remove_all(fs::temp_directory_path() / "aidaudio-tests-home");
  if (failures) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "All adapter tests passed\n";
  return 0;
}
