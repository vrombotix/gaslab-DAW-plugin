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
  // False for adapters whose host DAW has no confirmed scripting call to
  // import an audio file (e.g. FL Studio) - the UI should offer opening
  // the generation folder instead of an "import" action for these.
  bool supportsAutoImport{true};
  // True for bridges that can render the DAW's whole mix on request (renderMix).
  bool supportsRender{false};
};
}
