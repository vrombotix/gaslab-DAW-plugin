#pragma once
#include <aidaudio/IDawAdapter.hpp>

namespace aidaudio {
// Talks to Ableton Live via a Python Control Surface ("Remote Script") the
// user selects once in Settings > Link, Tempo & MIDI, after which it
// auto-loads with every set. Uses the same file-based request/status/result
// protocol as ArdourAdapter. The import uses Track.create_audio_clip, which
// only exists in Live 12.0.5+; unverified against a real Live install.
class AbletonAdapter final : public IDawAdapter {
public:
  DawInfo info() const override;
  bool launch() const override;
  bool queueImport(const Generation& generation, std::string& error) const override;

private:
  static std::string findExecutable();
  static bool processRunning();
  static bool bridgeHeartbeatFresh();
};
}
