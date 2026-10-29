#pragma once
#include <aidaudio/IDawAdapter.hpp>

namespace aidaudio {
// Logic Pro (macOS only) has no scripting API for importing audio; the only
// automation route is System Events UI scripting, which breaks on localized
// menu names and needs Accessibility permission. So there is no bridge:
// this adapter detects and launches Logic, `info().supportsAutoImport` is
// false, and stems reach Logic by dragging them out of the app.
class LogicAdapter final : public IDawAdapter {
public:
  DawInfo info() const override;
  bool launch() const override;
  bool queueImport(const Generation& generation, std::string& error) const override;

private:
  static std::string findExecutable();
  static bool processRunning();
};
}
