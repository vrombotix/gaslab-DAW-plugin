# UNVERIFIED against a real Ableton Live install - see __init__.py.
#
# Protocol: same import.request / bridge.status / import.result file
# convention as the Ardour and REAPER bridges, under a "ableton"
# subdirectory. Each stem becomes a new audio track holding one Arrangement
# clip at the current playhead, via Track.create_audio_clip(path, position)
# - the documented LOM call for loading a file by path, added in Live 12.0.5.

import os
import time

import Live
from _Framework.ControlSurface import ControlSurface

POLL_INTERVAL_SECONDS = 1.0
# Replaced with the real per-OS path by `daw-agent install-bridges`.
BRIDGE_DIR = "@AI_DAW_BRIDGE_DIR@"


def read_request(path):
    if not os.path.exists(path):
        return None
    req = {"generation_id": "", "assets": []}
    with open(path, "r") as f:
        for line in f:
            line = line.rstrip("\n")
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key == "generation_id":
                req["generation_id"] = value
            elif key == "asset" and "\t" in value:
                name, path_value = value.split("\t", 1)
                req["assets"].append({"name": name, "path": path_value})
    return req


def write_status(path):
    try:
        with open(path, "w") as f:
            f.write("ready\n")
            f.write("time=%d\n" % int(time.time()))
    except OSError:
        pass


def write_result(path, ok, message):
    try:
        with open(path, "w") as f:
            f.write("ok\n" if ok else "error\n")
            f.write((message or "") + "\n")
    except OSError:
        pass


class AI_DAW_Bridge(ControlSurface):
    def __init__(self, c_instance):
        super(AI_DAW_Bridge, self).__init__(c_instance)
        self._last_generation_id = ""
        self._last_poll = 0.0

    # Live calls update_display() roughly every 100 ms on every active
    # Control Surface, which makes it the polling timer.
    def update_display(self):
        super(AI_DAW_Bridge, self).update_display()
        now = time.time()
        if now - self._last_poll < POLL_INTERVAL_SECONDS:
            return
        self._last_poll = now

        d = BRIDGE_DIR
        write_status(os.path.join(d, "bridge.status"))

        req = read_request(os.path.join(d, "import.request"))
        if not req or not req["generation_id"] or req["generation_id"] == self._last_generation_id:
            return

        ok, message = self._import_generation(req)
        if ok:
            self._last_generation_id = req["generation_id"]
            # Consume the request so a future Live/script restart (which
            # starts _last_generation_id fresh) can't replay an old import.
            try:
                os.remove(os.path.join(d, "import.request"))
            except OSError:
                pass
        write_result(os.path.join(d, "import.result"), ok, message)
        write_status(os.path.join(d, "bridge.status"))

    def _import_generation(self, req):
        if not req["assets"]:
            return False, "No assets in request"
        if not hasattr(Live.Track.Track, "create_audio_clip"):
            return False, "Importing needs Ableton Live 12.0.5 or newer"

        song = self.song()
        # Read once so every stem starts at the same beat even while playing.
        position = song.current_song_time
        imported = 0
        try:
            for asset in req["assets"]:
                song.create_audio_track(-1)
                track = song.tracks[-1]
                track.name = asset["name"]
                track.create_audio_clip(asset["path"], position)
                imported += 1
        except Exception as e:  # noqa: BLE001 - surface any LOM failure as an import.result error
            return False, "Imported %d of %d stems, then failed: %s" % (imported, len(req["assets"]), e)
        return True, "Imported %d stems at beat %.2f" % (imported, position)
