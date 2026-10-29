#pragma once
#include <aidaudio/IDawAdapter.hpp>

namespace aidaudio {
// FL Studio's Python scripting API (MIDI controller scripts) has no call to
// load an audio file into a channel or the Playlist, so there is no bridge:
// this adapter detects and launches FL, `info().supportsAutoImport` is false,
// and stems reach FL by dragging them out of the app.
class FLStudioAdapter final : public IDawAdapter {
public:
  DawInfo info() const override;
  bool launch() const override;
  bool queueImport(const Generation& generation, std::string& error) const override;

private:
  static std::string findExecutable();
  static bool processRunning();
};
}
