#pragma once
#include <aidaudio/IDawAdapter.hpp>

namespace aidaudio {
// Talks to REAPER via a ReaScript (__startup.lua) that auto-loads on every
// project open - no manual per-session enable step, unlike Ardour. Uses the
// same file-based request/status/result protocol as ArdourAdapter.
class ReaperAdapter final : public IDawAdapter {
public:
  DawInfo info() const override;
  bool launch() const override;
  bool queueImport(const Generation& generation, std::string& error) const override;
  bool renderMix(const std::filesystem::path& file, std::string& error) const override;

private:
  static std::string findExecutable();
  static bool processRunning();
  static bool bridgeHeartbeatFresh();
};
}
