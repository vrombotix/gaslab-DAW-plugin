#pragma once
#include <aidaudio/Types.hpp>
#include <filesystem>
#include <string>

namespace aidaudio {
class IDawAdapter {
public:
  virtual ~IDawAdapter() = default;
  virtual DawInfo info() const = 0;
  virtual bool launch() const = 0;
  virtual bool queueImport(const Generation& generation, std::string& error) const = 0;
  // Renders the DAW's whole mix to the WAV `file`, blocking until done.
  // Only adapters reporting info().supportsRender implement it.
  virtual bool renderMix(const std::filesystem::path& file, std::string& error) const {
    (void)file;
    error = info().name + " can't render its mix on request - bounce it in the DAW and upload the file.";
    return false;
  }
};
}
