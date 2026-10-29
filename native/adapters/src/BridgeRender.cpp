#include <aidaudio/BridgeRender.hpp>
#include <fstream>
#include <thread>

namespace fs = std::filesystem;

namespace aidaudio {

bool renderViaBridge(const fs::path& bridgeDir, const fs::path& file, std::chrono::milliseconds timeout,
                     std::string& error) {
  const auto requestId = std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  const auto resultPath = bridgeDir / "render.result";
  const auto requestPath = bridgeDir / "render.request";
  std::error_code ec;
  fs::remove(resultPath, ec);  // a stale answer from an earlier render

  const auto tmp = bridgeDir / "render.request.tmp";
  {
    std::ofstream out(tmp, std::ios::trunc);
    out << "version=1\n";
    out << "request_id=" << requestId << "\n";
    out << "folder=" << file.parent_path().string() << "\n";
    out << "name=" << file.stem().string() << "\n";
    if (!out) {
      error = "Could not write the render request.";
      return false;
    }
  }
  fs::rename(tmp, requestPath, ec);
  if (ec) {
    error = "Could not publish the render request: " + ec.message();
    return false;
  }

  // The bridges write render.result atomically (tmp file + rename), and the
  // DAW is busy while it renders, so just poll until the answer appears.
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    std::ifstream in(resultPath);
    std::string id, status, message;
    if (std::getline(in, id) && id == requestId && std::getline(in, status)) {
      std::getline(in, message);
      if (status != "ok") {
        error = message.empty() ? "The DAW could not render the mix." : message;
        return false;
      }
      if (!fs::exists(file)) {
        error = "The DAW reported a render but " + file.string() + " is missing (it wrote: " + message + ").";
        return false;
      }
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  fs::remove(requestPath, ec);  // so the bridge doesn't render after we gave up
  error = "Timed out waiting for the DAW to render the mix.";
  return false;
}
}
