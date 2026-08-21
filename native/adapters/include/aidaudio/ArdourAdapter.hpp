#pragma once
#include <aidaudio/IDawAdapter.hpp>

namespace aidaudio {
class ArdourAdapter final : public IDawAdapter {
public:
  DawInfo info() const override;
  bool launch() const override;
  bool queueImport(const Generation& generation, std::string& error) const override;

  static std::filesystem::path bridgeDir();
private:
  static std::string findExecutable();
  static bool processRunning();
  static bool bridgeHeartbeatFresh();
};
}
