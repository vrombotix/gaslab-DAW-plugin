#include <aidaudio/ArdourAdapter.hpp>
#include <aidaudio/Types.hpp>
#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <curl/curl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;
namespace pt = boost::property_tree;
using aidaudio::Asset;
using aidaudio::Generation;

namespace {
fs::path homeDir() {
  if (const char* home = std::getenv("HOME")) return fs::path(home);
  return fs::temp_directory_path();
}

fs::path dataDir() {
  return homeDir() / ".local" / "share" / "ai-daw-prototype";
}

std::string jsonString(const pt::ptree& tree) {
  std::ostringstream os;
  pt::write_json(os, tree, false);
  return os.str();
}

void printError(const std::string& message, int code = 1) {
  pt::ptree root;
  root.put("ok", false);
  root.put("error", message);
  std::cout << jsonString(root);
  std::exit(code);
}

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

std::string httpPostJson(const std::string& url, const std::string& body) {
  CURL* curl = curl_easy_init();
  if (!curl) throw std::runtime_error("curl_easy_init failed");
  std::string response;
  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, "Content-Type: application/json");
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeString);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
  const auto result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  if (result != CURLE_OK) throw std::runtime_error(curl_easy_strerror(result));
  if (status < 200 || status >= 300) throw std::runtime_error("HTTP " + std::to_string(status) + ": " + response);
  return response;
}

void downloadFile(const std::string& url, const fs::path& destination) {
  fs::create_directories(destination.parent_path());
  auto part = destination;
  part += ".part";
  std::ofstream out(part, std::ios::binary | std::ios::trunc);
  if (!out) throw std::runtime_error("Cannot open download destination: " + part.string());
  CURL* curl = curl_easy_init();
  if (!curl) throw std::runtime_error("curl_easy_init failed");
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeFile);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out);
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 60L);
  const auto result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_cleanup(curl);
  out.close();
  if (result != CURLE_OK || status < 200 || status >= 300) {
    fs::remove(part);
    throw std::runtime_error("Download failed: " + url);
  }
  std::error_code ec;
  fs::rename(part, destination, ec);
  if (ec) throw std::runtime_error("Cannot finalize download: " + ec.message());
}

std::string absoluteUrl(const std::string& api, const std::string& url) {
  if (url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0) return url;
  if (!url.empty() && url.front() == '/') return api + url;
  return api + "/" + url;
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

std::string argValue(int argc, char** argv, const std::string& name, const std::string& fallback = {}) {
  for (int i = 2; i + 1 < argc; ++i) if (argv[i] == name) return argv[i + 1];
  return fallback;
}
}

int main(int argc, char** argv) {
  curl_global_init(CURL_GLOBAL_DEFAULT);
  if (argc < 2) printError("Usage: daw-agent <health|daws|generate|import|launch> ...");
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

    aidaudio::ArdourAdapter ardour;

    if (command == "daws") {
      const auto info = ardour.info();
      pt::ptree root, daws, item;
      root.put("ok", true);
      item.put("id", info.id);
      item.put("name", info.name);
      item.put("installed", info.installed);
      item.put("running", info.running);
      item.put("bridge_ready", info.bridgeReady);
      item.put("executable", info.executable);
      item.put("capabilities.generate", true);
      item.put("capabilities.import_audio", true);
      daws.push_back({"", item});
      root.add_child("daws", daws);
      std::cout << jsonString(root);
      return 0;
    }

    if (command == "launch") {
      const auto daw = argValue(argc, argv, "--daw", "ardour");
      if (daw != "ardour") printError("Only the Ardour adapter exists in prototype v0.1");
      const bool ok = ardour.launch();
      pt::ptree root;
      root.put("ok", ok);
      root.put("daw", "ardour");
      if (!ok) root.put("error", "Could not find or launch Ardour");
      std::cout << jsonString(root);
      return ok ? 0 : 2;
    }

    if (command == "generate") {
      const auto prompt = argValue(argc, argv, "--prompt", "Dark melodic techno");
      const auto api = argValue(argc, argv, "--api", "http://127.0.0.1:8787");
      std::ostringstream body;
      body << "{\"prompt\":\"";
      for (char c : prompt) {
        if (c == '\\' || c == '"') body << '\\';
        if (c == '\n') body << "\\n"; else body << c;
      }
      body << "\"}";

      const auto response = httpPostJson(api + "/v1/generations", body.str());
      pt::ptree remote;
      std::istringstream input(response);
      pt::read_json(input, remote);

      Generation g;
      g.id = remote.get<std::string>("id");
      g.title = remote.get<std::string>("title", "Demo Generation");
      g.prompt = remote.get<std::string>("prompt", prompt);
      g.bpm = remote.get<double>("bpm", 128.0);
      g.bars = remote.get<int>("bars", 8);

      auto dir = dataDir() / "generations" / g.id;
      fs::create_directories(dir);

      for (const auto& child : remote.get_child("assets")) {
        Asset a;
        a.role = child.second.get<std::string>("role");
        a.name = child.second.get<std::string>("name");
        a.url = child.second.get<std::string>("url");
        const auto filename = child.second.get<std::string>("filename");
        a.localPath = dir / filename;
        downloadFile(absoluteUrl(api, a.url), a.localPath);
        g.assets.push_back(std::move(a));
      }

      g.manifestPath = dir / "generation.json";
      auto manifestTree = generationJson(g);
      manifestTree.put("ok", true);
      std::ofstream manifest(g.manifestPath);
      pt::write_json(manifest, manifestTree, true);
      std::cout << jsonString(manifestTree);
      return 0;
    }

    if (command == "import") {
      const auto daw = argValue(argc, argv, "--daw", "ardour");
      const auto manifest = argValue(argc, argv, "--manifest");
      if (manifest.empty()) printError("--manifest is required");
      if (daw != "ardour") printError("Only the Ardour adapter exists in prototype v0.1");
      auto g = loadManifest(manifest);
      std::string error;
      const bool ok = ardour.queueImport(g, error);
      pt::ptree root;
      root.put("ok", ok);
      root.put("daw", "ardour");
      root.put("generation_id", g.id);
      root.put("queued", ok);
      if (!ok) root.put("error", error);
      std::cout << jsonString(root);
      return ok ? 0 : 2;
    }

    printError("Unknown command: " + command);
  } catch (const std::exception& e) {
    printError(e.what());
  }
}
