#include <aidaudio/AbletonAdapter.hpp>
#include <aidaudio/ArdourAdapter.hpp>
#include <aidaudio/FLStudioAdapter.hpp>
#include <aidaudio/IDawAdapter.hpp>
#include <aidaudio/LogicAdapter.hpp>
#include <aidaudio/PlatformPaths.hpp>
#include <aidaudio/ReaperAdapter.hpp>
#include <aidaudio/Types.hpp>
#include <chrono>
#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <curl/curl.h>
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace fs = std::filesystem;
namespace pt = boost::property_tree;
using aidaudio::Asset;
using aidaudio::Generation;
using aidaudio::IDawAdapter;

namespace {
fs::path dataDir() {
  return aidaudio::paths::appDataDir();
}

// Ardour and REAPER stay behind dev mode until Ableton Live, FL Studio and
// Logic Pro are solid: AI_DAW_DEV=1 (the desktop app sets it in `tauri dev`
// builds) lists, installs and drives them; without it they don't exist.
bool devMode() {
  const char* value = std::getenv("AI_DAW_DEV");
  return value && std::string_view(value) == "1";
}

std::vector<std::unique_ptr<IDawAdapter>> buildAdapters() {
  std::vector<std::unique_ptr<IDawAdapter>> adapters;
  adapters.push_back(std::make_unique<aidaudio::AbletonAdapter>());
  adapters.push_back(std::make_unique<aidaudio::FLStudioAdapter>());
  adapters.push_back(std::make_unique<aidaudio::LogicAdapter>());
  if (devMode()) {
    adapters.push_back(std::make_unique<aidaudio::ArdourAdapter>());
    adapters.push_back(std::make_unique<aidaudio::ReaperAdapter>());
  }
  return adapters;
}

IDawAdapter* findAdapter(const std::vector<std::unique_ptr<IDawAdapter>>& adapters, const std::string& id) {
  for (const auto& adapter : adapters) {
    if (adapter->info().id == id) return adapter.get();
  }
  return nullptr;
}

std::string jsonString(const pt::ptree& tree) {
  std::ostringstream os;
  pt::write_json(os, tree, false);
  return os.str();
}

[[noreturn]] void printError(const std::string& message, int code = 1, bool authRequired = false) {
  pt::ptree root;
  root.put("ok", false);
  root.put("error", message);
  // Tells the UI to show the sign-in form.
  if (authRequired) root.put("auth_required", true);
  std::cout << jsonString(root);
  std::exit(code);
}

pt::ptree parseJson(const std::string& text) {
  pt::ptree tree;
  std::istringstream input(text);
  pt::read_json(input, tree);
  return tree;
}

struct HttpError : std::runtime_error {
  long status;  // 0 when the server was never reached
  HttpError(long status, const std::string& message) : std::runtime_error(message), status(status) {}
};

size_t writeString(void* ptr, size_t size, size_t nmemb, void* userdata) {
  auto* s = static_cast<std::string*>(userdata);
  s->append(static_cast<char*>(ptr), size * nmemb);
  return size * nmemb;
}

size_t writeFile(void* ptr, size_t size, size_t nmemb, void* userdata) {
  auto* out = static_cast<std::ofstream*>(userdata);
  out->write(static_cast<char*>(ptr), static_cast<std::streamsize>(size * nmemb));
  return size * nmemb;
}

size_t readFile(char* buffer, size_t size, size_t nitems, void* userdata) {
  auto* in = static_cast<std::ifstream*>(userdata);
  in->read(buffer, static_cast<std::streamsize>(size * nitems));
  return static_cast<size_t>(in->gcount());
}

// The API's own {"error": "..."} message when it sent one.
std::string apiErrorMessage(long status, const std::string& body) {
  try {
    if (auto message = parseJson(body).get_optional<std::string>("error")) return *message;
  } catch (const pt::json_parser_error&) {
  }
  return "HTTP " + std::to_string(status);
}

// One API request. `configure` sets the method/body (and may redirect the
// response into a file); the bearer token is added when given. Throws
// HttpError unless the server answered 2xx; returns the response body.
std::string http(const std::string& url, const std::string& token,
                 const std::function<void(CURL*)>& configure = [](CURL*) {},
                 std::vector<std::string> headers = {}) {
  CURL* curl = curl_easy_init();
  if (!curl) throw std::runtime_error("curl_easy_init failed");
  std::string response;
  if (!token.empty()) headers.push_back("Authorization: Bearer " + token);
  curl_slist* headerList = nullptr;
  for (const auto& h : headers) headerList = curl_slist_append(headerList, h.c_str());
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headerList);
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  // No total timeout - mixes can be large - but give up on a stalled transfer.
  curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1L);
  curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 60L);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeString);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
  configure(curl);
  const auto result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(headerList);
  curl_easy_cleanup(curl);
  if (result != CURLE_OK) throw HttpError(0, curl_easy_strerror(result));
  if (status < 200 || status >= 300) throw HttpError(status, apiErrorMessage(status, response));
  return response;
}

pt::ptree getJson(const std::string& url, const std::string& token) {
  return parseJson(http(url, token));
}

pt::ptree postJson(const std::string& url, const std::string& token, const pt::ptree& body) {
  const auto payload = jsonString(body);
  return parseJson(http(url, token, [&](CURL* curl) {
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload.c_str());
  }, {"Content-Type: application/json"}));
}

void downloadFile(const std::string& url, const std::string& token, const fs::path& destination) {
  fs::create_directories(destination.parent_path());
  auto part = destination;
  part += ".part";
  std::ofstream out(part, std::ios::binary | std::ios::trunc);
  if (!out) throw std::runtime_error("Cannot open download destination: " + part.string());
  try {
    http(url, token, [&](CURL* curl) {
      curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeFile);
      curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
    });
  } catch (const HttpError& e) {
    out.close();
    fs::remove(part);
    throw HttpError(e.status, std::string("Download failed (") + e.what() + "): " + url);
  }
  out.close();
  std::error_code ec;
  fs::rename(part, destination, ec);
  if (ec) throw std::runtime_error("Cannot finalize download: " + ec.message());
}

pt::ptree uploadFile(const std::string& url, const std::string& token, const fs::path& file) {
  std::ifstream in(file, std::ios::binary);
  if (!in) throw std::runtime_error("Cannot read " + file.string());
  const auto size = static_cast<curl_off_t>(fs::file_size(file));
  return parseJson(http(url, token, [&](CURL* curl) {
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_READFUNCTION, readFile);
    curl_easy_setopt(curl, CURLOPT_READDATA, &in);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, size);
  }, {"Content-Type: application/octet-stream", "Expect:"}));
}

std::string absoluteUrl(const std::string& api, const std::string& url) {
  if (url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0) return url;
  if (!url.empty() && url.front() == '/') return api + url;
  return api + "/" + url;
}

std::string urlEncode(const std::string& text) {
  std::ostringstream out;
  for (unsigned char c : text) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out << c;
    } else {
      out << '%' << std::uppercase << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(c);
    }
  }
  return out.str();
}

// API-provided ids and file names become local paths and URL segments, so
// only plain names are accepted - a bad response can't write outside the
// data dir.
bool isSafeId(const std::string& id) {
  return !id.empty() && id.size() <= 128 &&
         std::all_of(id.begin(), id.end(), [](unsigned char c) { return std::isalnum(c) || c == '-' || c == '_'; });
}

bool isSafeFilename(const std::string& name) {
  return !name.empty() && name != "." && name != ".." && name.find_first_of("/\\:") == std::string::npos;
}

// The signed-in user's API session, kept between agent runs.
// ponytail: a file only the user can read; move the token into the OS
// keychain (Keychain / Credential Manager / libsecret) before production.
struct Session {
  std::string api;
  std::string token;
  std::string email;
};

fs::path sessionPath() {
  return dataDir() / "session.json";
}

std::optional<Session> loadSession() {
  pt::ptree tree;
  try {
    pt::read_json(sessionPath().string(), tree);
  } catch (const pt::json_parser_error&) {
    return std::nullopt;
  }
  return Session{tree.get("api", ""), tree.get("token", ""), tree.get("email", "")};
}

void saveSession(const Session& session) {
  const auto path = sessionPath();
  fs::create_directories(path.parent_path());
  // Restrict the still-empty file before the token goes into it.
  { std::ofstream create(path, std::ios::trunc); }
  fs::permissions(path, fs::perms::owner_read | fs::perms::owner_write);
  pt::ptree tree;
  tree.put("api", session.api);
  tree.put("token", session.token);
  tree.put("email", session.email);
  std::ofstream out(path, std::ios::trunc);
  pt::write_json(out, tree);
}

Session requireSession() {
  auto session = loadSession();
  if (!session || session->token.empty()) printError("Sign in first.", 1, true);
  return *session;
}

std::string argValue(int argc, char** argv, const std::string& name, const std::string& fallback = {});

// --api wins, then the API the session signed in to, then the local mock.
std::string apiBase(int argc, char** argv, const std::optional<Session>& session = std::nullopt) {
  auto api = argValue(argc, argv, "--api");
  if (api.empty() && session) api = session->api;
  return api.empty() ? "http://127.0.0.1:8787" : api;
}

Generation loadManifest(const fs::path& path) {
  pt::ptree root;
  pt::read_json(path.string(), root);
  Generation g;
  g.id = root.get<std::string>("id");
  g.title = root.get<std::string>("title", "Generated Track");
  g.prompt = root.get<std::string>("prompt", "");
  g.bpm = root.get<double>("bpm", 128.0);
  g.bars = root.get<int>("bars", 8);
  g.manifestPath = path;
  for (const auto& child : root.get_child("assets")) {
    Asset a;
    a.role = child.second.get<std::string>("role");
    a.name = child.second.get<std::string>("name");
    a.url = child.second.get<std::string>("url", "");
    a.localPath = child.second.get<std::string>("local_path");
    g.assets.push_back(std::move(a));
  }
  return g;
}

pt::ptree generationJson(const Generation& g) {
  pt::ptree root;
  root.put("ok", true);
  root.put("id", g.id);
  root.put("title", g.title);
  root.put("prompt", g.prompt);
  root.put("bpm", g.bpm);
  root.put("bars", g.bars);
  root.put("manifest_path", g.manifestPath.string());
  pt::ptree arr;
  for (const auto& asset : g.assets) {
    pt::ptree item;
    item.put("role", asset.role);
    item.put("name", asset.name);
    item.put("url", asset.url);
    item.put("local_path", asset.localPath.string());
    arr.push_back({"", item});
  }
  root.add_child("assets", arr);
  return root;
}

// Downloads a song's stems into generations/<id>/ and writes the manifest
// that `import` reads. Stems already on disk are kept: downloads land via
// .part files, so an existing file is always complete.
pt::ptree downloadSong(const pt::ptree& song, const std::string& api, const std::string& token) {
  Generation g;
  g.id = song.get<std::string>("id");
  if (!isSafeId(g.id)) throw std::runtime_error("The API returned an invalid song id: " + g.id);
  g.title = song.get<std::string>("title", "Generated Track");
  g.prompt = song.get<std::string>("prompt", "");
  g.bpm = song.get<double>("bpm", 128.0);
  g.bars = song.get<int>("bars", 8);
  const auto dir = dataDir() / "generations" / g.id;

  for (const auto& child : song.get_child("assets")) {
    Asset a;
    a.role = child.second.get<std::string>("role");
    a.name = child.second.get<std::string>("name");
    a.url = child.second.get<std::string>("url");
    const auto filename = child.second.get<std::string>("filename");
    if (!isSafeFilename(filename)) throw std::runtime_error("The API returned an invalid file name: " + filename);
    a.localPath = dir / filename;
    if (!fs::exists(a.localPath)) downloadFile(absoluteUrl(api, a.url), token, a.localPath);
    g.assets.push_back(std::move(a));
  }

  fs::create_directories(dir);
  g.manifestPath = dir / "generation.json";
  const auto manifest = generationJson(g);
  std::ofstream out(g.manifestPath);
  pt::write_json(out, manifest, true);
  return manifest;
}

std::string argValue(int argc, char** argv, const std::string& name, const std::string& fallback) {
  for (int i = 2; i + 1 < argc; ++i) if (argv[i] == name) return argv[i + 1];
  return fallback;
}

struct BridgeInstallResult {
  std::string daw;
  bool ok{false};
  std::string detail;
  fs::path path;
};

// Bridge scripts carry this placeholder where they need their bridge
// directory; it is replaced at install time so the per-OS data-dir
// convention lives only in paths::appDataDir(), not in every script.
constexpr std::string_view kBridgeDirPlaceholder = "@AI_DAW_BRIDGE_DIR@";

// REAPER only auto-runs Scripts/__startup.lua, which may hold the user's own
// startup code - so the bridge is installed beside it and this line is
// appended once (recognised by the script path) instead of overwriting the file.
constexpr std::string_view kReaperBridgeScript = "/Scripts/ai_daw_import_bridge.lua";
constexpr std::string_view kReaperStartupLine =
  "dofile(reaper.GetResourcePath() .. \"/Scripts/ai_daw_import_bridge.lua\") -- Gaslab DAW Plugin";

std::string readText(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

bool installScript(const fs::path& src, const fs::path& dst, const std::string& daw, std::string& error) {
  if (!fs::exists(src)) {
    error = "Missing bridge script: " + src.string();
    return false;
  }
  const auto bridgeDir = aidaudio::paths::bridgeDir(daw);
  const auto u8 = bridgeDir.generic_u8string();
  const std::string dir(u8.begin(), u8.end());
  auto text = readText(src);
  for (auto pos = text.find(kBridgeDirPlaceholder); pos != std::string::npos;
       pos = text.find(kBridgeDirPlaceholder, pos + dir.size())) {
    text.replace(pos, kBridgeDirPlaceholder.size(), dir);
  }

  std::error_code ec;
  // The scripts only write files, they never create directories.
  fs::create_directories(bridgeDir, ec);
  if (!ec) fs::create_directories(dst.parent_path(), ec);
  if (ec) {
    error = ec.message();
    return false;
  }
  std::ofstream out(dst, std::ios::binary | std::ios::trunc);
  out << text;
  if (!out) {
    error = "Could not write " + dst.string();
    return false;
  }
  return true;
}

// Appends `line` unless the file already mentions `marker`.
bool appendLineOnce(const fs::path& file, std::string_view line, std::string_view marker, std::string& error) {
  const auto text = readText(file);
  if (text.find(marker) != std::string::npos) return true;
  std::ofstream out(file, std::ios::binary | std::ios::app);
  if (!text.empty() && text.back() != '\n') out << '\n';
  out << line << '\n';
  if (!out) {
    error = "Could not update " + file.string();
    return false;
  }
  return true;
}

// Installs each DAW's bridge script from integrationsDir() to that DAW's
// script-loading directory, always overwriting so a stale bundled script
// can never linger (the class of bug that caused most of the Ardour bridge
// debugging: a script directory holding an older, subtly broken copy).
// Best-effort per DAW - one missing/unwritable destination does not stop
// the others from being installed.
std::vector<BridgeInstallResult> installBridges() {
  namespace paths = aidaudio::paths;
  const auto integrations = paths::integrationsDir();
  std::vector<BridgeInstallResult> results;

  if (devMode()) {
    {
      BridgeInstallResult r{"ardour"};
      std::string error;
      r.path = paths::ardourScriptsDir() / "ai_daw_import_bridge.lua";
      r.ok = installScript(integrations / "ardour" / "ai_daw_import_bridge.lua", r.path, "ardour", error);
      r.detail = r.ok ? "installed" : error;
      results.push_back(r);
    }
    {
      BridgeInstallResult r{"reaper"};
      std::string error;
      r.path = paths::reaperScriptsDir() / "ai_daw_import_bridge.lua";
      r.ok = installScript(integrations / "reaper" / "ai_daw_import_bridge.lua", r.path, "reaper", error) &&
             appendLineOnce(paths::reaperScriptsDir() / "__startup.lua", kReaperStartupLine, kReaperBridgeScript, error);
      r.detail = r.ok ? "installed" : error;
      results.push_back(r);
    }
  }
  {
    BridgeInstallResult r{"ableton"};
    std::string error;
    r.path = paths::abletonRemoteScriptsDir() / "Gaslab_DAW_Plugin";
    const auto src = integrations / "ableton" / "Gaslab_DAW_Plugin";
    r.ok = installScript(src / "__init__.py", r.path / "__init__.py", "ableton", error) &&
           installScript(src / "daw_plugin.py", r.path / "daw_plugin.py", "ableton", error);
    r.detail = r.ok ? "installed" : error;
    results.push_back(r);
  }

  return results;
}
}

int main(int argc, char** argv) {
  curl_global_init(CURL_GLOBAL_DEFAULT);
  if (argc < 2) printError("Usage: daw-agent <health|daws|login|logout|songs|download|upload|export|import|launch|install-bridges> ...");
  const std::string command = argv[1];

  try {
    if (command == "health") {
      pt::ptree root;
      root.put("ok", true);
      root.put("service", "daw-agent");
      root.put("protocol_version", 1);
      root.put("data_dir", dataDir().string());
      std::cout << jsonString(root);
      return 0;
    }

    const auto adapters = buildAdapters();

    if (command == "daws") {
      pt::ptree root, daws;
      root.put("ok", true);
      for (const auto& adapter : adapters) {
        const auto info = adapter->info();
        pt::ptree item;
        item.put("id", info.id);
        item.put("name", info.name);
        item.put("installed", info.installed);
        item.put("running", info.running);
        item.put("bridge_ready", info.bridgeReady);
        item.put("executable", info.executable);
        item.put("supports_auto_import", info.supportsAutoImport);
        item.put("supports_render", info.supportsRender);
        item.put("capabilities.generate", true);
        item.put("capabilities.import_audio", info.supportsAutoImport);
        daws.push_back({"", item});
      }
      root.add_child("daws", daws);
      std::cout << jsonString(root);
      return 0;
    }

    if (command == "launch") {
      const auto daw = argValue(argc, argv, "--daw", "ardour");
      auto* adapter = findAdapter(adapters, daw);
      if (!adapter) printError("Unknown DAW: " + daw);
      const bool ok = adapter->launch();
      pt::ptree root;
      root.put("ok", ok);
      root.put("daw", daw);
      if (!ok) root.put("error", "Could not find or launch " + daw);
      std::cout << jsonString(root);
      return ok ? 0 : 2;
    }

    if (command == "login") {
      const auto email = argValue(argc, argv, "--email");
      // The password arrives through the environment, never argv, which
      // other local users can read via ps.
      const char* password = std::getenv("AI_DAW_PASSWORD");
      if (email.empty() || !password || !*password) printError("Email and password are required.");
      const auto api = apiBase(argc, argv);
      pt::ptree credentials;
      credentials.put("email", email);
      credentials.put("password", password);
      const auto reply = postJson(api + "/v1/auth/login", "", credentials);
      const Session session{api, reply.get<std::string>("token"), reply.get<std::string>("user.email", email)};
      saveSession(session);
      pt::ptree root;
      root.put("ok", true);
      root.put("user.email", session.email);
      std::cout << jsonString(root);
      return 0;
    }

    if (command == "logout") {
      std::error_code ec;
      fs::remove(sessionPath(), ec);
      pt::ptree root;
      root.put("ok", true);
      std::cout << jsonString(root);
      return 0;
    }

    if (command == "songs") {
      const auto session = requireSession();
      auto reply = getJson(apiBase(argc, argv, session) + "/v1/songs", session.token);
      reply.put("ok", true);
      reply.put("user.email", session.email);
      std::cout << jsonString(reply);
      return 0;
    }

    if (command == "download") {
      const auto session = requireSession();
      const auto api = apiBase(argc, argv, session);
      const auto id = argValue(argc, argv, "--song");
      if (!isSafeId(id)) printError("--song needs a song id");
      const auto song = getJson(api + "/v1/songs/" + id, session.token);
      std::cout << jsonString(downloadSong(song, api, session.token));
      return 0;
    }

    if (command == "upload") {
      const auto session = requireSession();
      const auto id = argValue(argc, argv, "--song");
      const fs::path file = argValue(argc, argv, "--file");
      if (!isSafeId(id)) printError("--song needs a song id");
      if (file.empty() || !fs::is_regular_file(file)) printError("--file must be an existing audio file");
      const auto name = file.filename().u8string();
      const auto url = apiBase(argc, argv, session) + "/v1/songs/" + id +
                       "/uploads?filename=" + urlEncode(std::string(name.begin(), name.end()));
      auto reply = uploadFile(url, session.token, file);
      reply.put("ok", true);
      std::cout << jsonString(reply);
      return 0;
    }

    // Has the DAW render its whole mix, then uploads that file to the song.
    if (command == "export") {
      const auto session = requireSession();
      const auto daw = argValue(argc, argv, "--daw");
      const auto id = argValue(argc, argv, "--song");
      auto* adapter = findAdapter(adapters, daw);
      if (!adapter) printError("Unknown DAW: " + daw);
      if (!isSafeId(id)) printError("--song needs a song id");
      const auto folder = dataDir() / "renders" / id;
      fs::create_directories(folder);
      const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
      std::ostringstream name;
      name << daw << "-mix-" << std::put_time(std::localtime(&now), "%Y%m%d-%H%M%S") << ".wav";
      const auto file = folder / name.str();
      std::string error;
      if (!adapter->renderMix(file, error)) printError(error, 2);
      auto reply = uploadFile(apiBase(argc, argv, session) + "/v1/songs/" + id + "/uploads?filename=" + urlEncode(name.str()),
                              session.token, file);
      reply.put("ok", true);
      reply.put("file", file.string());
      std::cout << jsonString(reply);
      return 0;
    }

    if (command == "import") {
      const auto daw = argValue(argc, argv, "--daw", "ardour");
      const auto manifest = argValue(argc, argv, "--manifest");
      if (manifest.empty()) printError("--manifest is required");
      auto* adapter = findAdapter(adapters, daw);
      if (!adapter) printError("Unknown DAW: " + daw);
      auto g = loadManifest(manifest);
      std::string error;
      const bool ok = adapter->queueImport(g, error);
      pt::ptree root;
      root.put("ok", ok);
      root.put("daw", daw);
      root.put("generation_id", g.id);
      root.put("queued", ok);
      if (!ok) root.put("error", error);
      std::cout << jsonString(root);
      return ok ? 0 : 2;
    }

    if (command == "install-bridges") {
      const auto results = installBridges();
      pt::ptree root, list;
      bool anyOk = false;
      for (const auto& r : results) {
        pt::ptree item;
        item.put("daw", r.daw);
        item.put("ok", r.ok);
        item.put("detail", r.detail);
        item.put("path", r.path.string());
        list.push_back({"", item});
        anyOk = anyOk || r.ok;
      }
      root.put("ok", anyOk);
      root.add_child("results", list);
      std::cout << jsonString(root);
      return anyOk ? 0 : 2;
    }

    printError("Unknown command: " + command);
  } catch (const HttpError& e) {
    // The API rejected the token: forget it so the UI asks to sign in again.
    if (e.status == 401) {
      std::error_code ec;
      fs::remove(sessionPath(), ec);
    }
    printError(e.what(), 1, e.status == 401);
  } catch (const std::exception& e) {
    printError(e.what());
  }
}
