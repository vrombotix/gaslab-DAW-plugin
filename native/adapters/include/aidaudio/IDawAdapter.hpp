#pragma once
#include <aidaudio/Types.hpp>
#include <string>

namespace aidaudio {
class IDawAdapter {
public:
  virtual ~IDawAdapter() = default;
  virtual DawInfo info() const = 0;
  virtual bool launch() const = 0;
  virtual bool queueImport(const Generation& generation, std::string& error) const = 0;
};
}
