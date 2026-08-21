#pragma once
#include <filesystem>
#include <string>
#include <vector>

namespace aidaudio {
struct Asset {
  std::string role;
  std::string name;
  std::string url;
  std::filesystem::path localPath;
};

struct Generation {
  std::string id;
  std::string title;
  std::string prompt;
  double bpm{128.0};
  int bars{8};
  std::vector<Asset> assets;
  std::filesystem::path manifestPath;
};

struct DawInfo {
  std::string id;
  std::string name;
  bool installed{false};
  bool running{false};
  bool bridgeReady{false};
  std::string executable;
};
}
