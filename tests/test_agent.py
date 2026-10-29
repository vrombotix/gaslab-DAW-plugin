#!/usr/bin/env python3
"""Tests for the daw-agent CLI and the DAW bridge protocol. Run by ctest
(`ctest --test-dir build`), which passes the built agent in DAW_AGENT.

Every test gets a throwaway HOME/USERPROFILE/APPDATA, so the agent's data dir
and every DAW script dir it installs into live in a temp directory. The DAW
side of each bridge runs against stubs: Ableton's Python in-process, Ardour's
and REAPER's Lua through tests/bridge_harness.lua - skipped when no `lua` is
on PATH, unless LUA names an interpreter.
Ardour and REAPER only exist in dev mode (AI_DAW_DEV=1), which the tests
that use them switch on.
"""
import http.server
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = os.environ.get("DAW_AGENT") or str(ROOT / "build" / "daw-agent")
LUA = os.environ.get("LUA") or shutil.which("lua") or shutil.which("lua5.4")
STEMS = ROOT / "apps" / "desktop" / "src-tauri" / "assets"


class MockApi(http.server.BaseHTTPRequestHandler):
    """The schemas/api.md contract served from stdlib. Its state lives on the
    server (see start_api) so tests can inspect what the agent sent. Every
    account owns two tracks, created at its first sign-in."""

    def do_POST(self):
        api, (path, _, query) = self.server, self.path.partition("?")
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if path == "/v1/auth/login":
            credentials = json.loads(body)
            if credentials.get("password") != "demo":
                return self._json(401, {"error": "Invalid email or password"})
            email = credentials["email"]
            api.tokens["tok-" + email] = email
            api.songs.setdefault(email, [self._track(email, title) for title in ("Night Drive", "Sunday Lofi")])
            return self._json(200, {"token": "tok-" + email, "user": {"email": email}})
        if not self._owner():
            return
        match = re.fullmatch(r"/v1/songs/([^/]+)/uploads", path)
        if match:
            filename = urllib.parse.parse_qs(query).get("filename", [""])[0]
            api.uploads.append({"song": match[1], "filename": filename, "body": body,
                                "content_type": self.headers["Content-Type"]})
            return self._json(200, {"upload": {"id": "upload-1", "filename": filename, "size": len(body),
                                               "url": "/v1/uploads/upload-1"}})
        self._json(404, {"error": "Not found"})

    def do_GET(self):
        api, owner = self.server, self._owner()
        if not owner:
            return
        if self.path == "/v1/songs":
            return self._json(200, {"songs": api.songs[owner]})
        if self.path.startswith("/v1/songs/"):
            if api.song_override:  # a hostile or broken reply, for the safety tests
                return self._json(200, api.song_override)
            song = next((s for s in api.songs[owner] if s["id"] == self.path.rsplit("/", 1)[-1]), None)
            return self._json(200, song) if song else self._json(404, {"error": "Song not found"})
        path = STEMS / self.path.rsplit("/", 1)[-1]
        if self.path.startswith("/v1/assets/") and path.is_file():
            api.downloads += 1
            return self._send(200, "audio/wav", path.read_bytes())
        self._json(404, {"error": "Not found"})

    def _track(self, owner, title):
        self.server.next_id += 1
        return {"id": f"song-{self.server.next_id}", "title": title, "owner": owner, "bpm": 120, "bars": 4,
                "created_at": 1790000000 - self.server.next_id, "uploads": [],
                "assets": [{"role": p.stem, "name": p.stem.title(), "filename": p.name,
                            "url": "/v1/assets/" + p.name} for p in sorted(STEMS.glob("*.wav"))]}

    def _owner(self):
        """The signed-in email for the request's token, or None after answering 401."""
        owner = self.server.tokens.get(self.headers.get("Authorization", "").removeprefix("Bearer "))
        if owner is None:
            self._json(401, {"error": "Sign in required"})
        return owner

    def _json(self, status, data):
        self._send(status, "application/json", json.dumps(data).encode())

    def _send(self, status, content_type, data):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class AgentTestCase(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home),
                        APPDATA=str(self.home / "AppData"),
                        AI_DAW_INTEGRATIONS_DIR=str(ROOT / "integrations"))

    def agent(self, *args, password=None):
        env = dict(self.env, AI_DAW_PASSWORD=password) if password else self.env
        out = subprocess.run([AGENT, *args], env=env, capture_output=True, text=True, timeout=60)
        return json.loads(out.stdout)

    def dev_mode(self):
        self.env["AI_DAW_DEV"] = "1"

    def start_api(self):
        """Starts the stub API; returns the server, whose attributes are its state."""
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockApi)
        server.tokens, server.songs, server.uploads, server.downloads, server.next_id, server.song_override = {}, {}, [], 0, 0, None
        server.url = f"http://127.0.0.1:{server.server_port}"
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def sign_in(self, email="ana@example.com", api=None):
        api = api or self.start_api()
        result = self.agent("login", "--email", email, "--api", api.url, password="demo")
        self.assertEqual(result["ok"], "true", result)
        return api

    def first_track(self):
        return self.agent("songs")["songs"][0]["id"]

    def install(self):
        """Runs install-bridges; returns {daw: installed script path}."""
        result = self.agent("install-bridges")
        self.assertEqual(result["ok"], "true", result)
        return {r["daw"]: Path(r["path"]) for r in result["results"]}

    def make_generation(self):
        """Writes a two-stem generation manifest; returns (manifest, stem paths)."""
        assets = []
        for name in ("Drums", "Bass"):
            wav = self.home / (name.lower() + ".wav")
            wav.write_bytes(b"RIFF")
            assets.append({"role": name.lower(), "name": name, "local_path": str(wav)})
        manifest = self.home / "generation.json"
        manifest.write_text(json.dumps({"id": "gen-1", "title": "Test", "assets": assets}))
        return manifest, [a["local_path"] for a in assets]


class TestCli(AgentTestCase):
    def test_health_reports_data_dir_under_home(self):
        result = self.agent("health")
        self.assertEqual(result["ok"], "true")
        self.assertTrue(Path(result["data_dir"]).is_relative_to(self.home), result["data_dir"])

    def test_lists_ableton_fl_studio_and_logic(self):
        daws = {d["id"]: d for d in self.agent("daws")["daws"]}
        self.assertEqual(list(daws), ["ableton", "flstudio", "logic"])
        self.assertEqual((daws["ableton"]["supports_auto_import"], daws["ableton"]["bridge_ready"]), ("true", "false"))
        for daw in ("flstudio", "logic"):
            self.assertEqual(daws[daw]["supports_auto_import"], "false")
        for daw in daws.values():
            self.assertEqual(daw["supports_render"], "false")

    def test_ardour_and_reaper_only_exist_in_dev_mode(self):
        manifest, _ = self.make_generation()
        self.assertIn("Unknown DAW", self.agent("import", "--daw", "ardour", "--manifest", str(manifest))["error"])
        self.assertEqual(list(self.install()), ["ableton"], "release builds leave Ardour/REAPER script folders alone")

        self.dev_mode()
        daws = {d["id"]: d for d in self.agent("daws")["daws"]}
        self.assertEqual(list(daws), ["ableton", "flstudio", "logic", "ardour", "reaper"])
        for daw in ("ardour", "reaper"):
            self.assertEqual((daws[daw]["supports_auto_import"], daws[daw]["supports_render"]), ("true", "true"))
        self.assertEqual(sorted(self.install()), ["ableton", "ardour", "reaper"])

    def test_download_fetches_every_stem(self):
        self.sign_in()
        result = self.agent("download", "--song", self.first_track())
        self.assertEqual(result["ok"], "true", result)
        self.assertEqual(result["title"], "Night Drive")
        self.assertEqual(len(result["assets"]), 4)
        for asset in result["assets"]:
            local = Path(asset["local_path"])
            self.assertEqual(local.read_bytes(), (STEMS / local.name).read_bytes())
            self.assertFalse(local.with_name(local.name + ".part").exists())
        self.assertEqual(json.loads(Path(result["manifest_path"]).read_text())["title"], "Night Drive")

    def test_unreachable_api_is_reported(self):
        self.sign_in()
        result = self.agent("songs", "--api", "http://127.0.0.1:9")
        self.assertEqual(result["ok"], "false")
        self.assertTrue(result["error"])
        self.assertNotIn("auth_required", result)

    def test_drag_only_daws_refuse_import_with_a_hint(self):
        manifest, _ = self.make_generation()
        for daw in ("flstudio", "logic"):
            result = self.agent("import", "--daw", daw, "--manifest", str(manifest))
            self.assertEqual(result["ok"], "false")
            self.assertIn("Drag", result["error"])

    def test_import_without_bridge_is_refused(self):
        manifest, _ = self.make_generation()
        result = self.agent("import", "--daw", "ableton", "--manifest", str(manifest))
        self.assertEqual(result["queued"], "false")
        self.assertIn("not running", result["error"])

    def test_rejects_bad_input(self):
        manifest, _ = self.make_generation()
        self.assertIn("Unknown DAW", self.agent("import", "--daw", "cubase", "--manifest", str(manifest))["error"])
        self.assertIn("--manifest", self.agent("import", "--daw", "ableton")["error"])
        self.assertIn("Unknown command", self.agent("bogus")["error"])

    def test_install_bridges_writes_the_bridge_dir_into_each_script(self):
        self.dev_mode()
        installed = self.install()
        data_dir = Path(self.agent("health")["data_dir"])
        for daw, script in [("ardour", installed["ardour"]), ("reaper", installed["reaper"]),
                            ("ableton", installed["ableton"] / "AI_DAW_Bridge.py")]:
            text = script.read_text()
            self.assertNotIn("@AI_DAW_BRIDGE_DIR@", text)
            self.assertIn((data_dir / daw).as_posix(), text)
            self.assertTrue((data_dir / daw).is_dir(), "bridges never create their own directory")

    def test_install_bridges_keeps_the_users_reaper_startup_script(self):
        self.dev_mode()
        startup = self.install()["reaper"].parent / "__startup.lua"
        startup.write_text("-- the user's own startup code")
        self.install()
        self.install()
        text = startup.read_text()
        self.assertTrue(text.startswith("-- the user's own startup code\n"), text)
        self.assertEqual(text.count("ai_daw_import_bridge.lua"), 1, text)


class TestApi(AgentTestCase):
    def session_file(self):
        return Path(self.agent("health")["data_dir"]) / "session.json"

    def test_login_keeps_a_private_session_without_the_password(self):
        api = self.sign_in()
        session = json.loads(self.session_file().read_text())
        self.assertEqual((session["api"], session["token"], session["email"]),
                         (api.url, "tok-ana@example.com", "ana@example.com"))
        self.assertNotIn("demo", self.session_file().read_text())
        if os.name == "posix":
            self.assertEqual(self.session_file().stat().st_mode & 0o777, 0o600)

    def test_login_rejects_a_wrong_password(self):
        api = self.start_api()
        result = self.agent("login", "--email", "ana@example.com", "--api", api.url, password="nope")
        self.assertEqual((result["ok"], result["error"]), ("false", "Invalid email or password"))
        self.assertFalse(self.session_file().exists())

    def test_login_needs_the_password_from_the_environment(self):
        result = self.agent("login", "--email", "ana@example.com", "--api", self.start_api().url)
        self.assertEqual(result["ok"], "false")
        self.assertIn("password", result["error"])

    def test_api_commands_ask_to_sign_in_first(self):
        manifest, stems = self.make_generation()
        for args in (["songs"], ["download", "--song", "song-1"],
                     ["upload", "--song", "song-1", "--file", stems[0]]):
            result = self.agent(*args)
            self.assertEqual((result["ok"], result.get("auth_required")), ("false", "true"), args)

    def test_a_rejected_token_signs_out(self):
        api = self.sign_in()
        api.tokens.clear()  # e.g. the session expired on the server
        result = self.agent("songs")
        self.assertEqual((result["error"], result["auth_required"]), ("Sign in required", "true"))
        self.assertFalse(self.session_file().exists())

    def test_logout_forgets_the_session(self):
        self.sign_in()
        self.assertEqual(self.agent("logout")["ok"], "true")
        self.assertFalse(self.session_file().exists())
        self.assertEqual(self.agent("songs")["auth_required"], "true")

    def test_songs_lists_only_the_tracks_the_user_owns(self):
        api = self.sign_in("bob@example.com")
        self.sign_in("ana@example.com", api)
        result = self.agent("songs")
        self.assertEqual(result["user"]["email"], "ana@example.com")
        self.assertEqual([song["title"] for song in result["songs"]], ["Night Drive", "Sunday Lofi"])
        self.assertEqual({song["owner"] for song in result["songs"]}, {"ana@example.com"})
        self.assertNotIn(api.songs["bob@example.com"][0]["id"], [song["id"] for song in result["songs"]])

    def test_download_fetches_a_songs_stems_once(self):
        api = self.sign_in()
        song_id = self.first_track()
        self.agent("download", "--song", song_id)
        self.assertEqual(api.downloads, 4)
        result = self.agent("download", "--song", song_id)
        self.assertEqual(result["ok"], "true", result)
        self.assertEqual(api.downloads, 4, "stems already on disk are not downloaded again")

        shutil.rmtree(Path(result["manifest_path"]).parent)
        result = self.agent("download", "--song", song_id)
        self.assertEqual(api.downloads, 8)
        for asset in result["assets"]:
            self.assertTrue(Path(asset["local_path"]).is_file())

    def test_download_of_an_unknown_song_fails(self):
        self.sign_in()
        self.assertEqual(self.agent("download", "--song", "song-404")["error"], "Song not found")
        self.assertIn("song id", self.agent("download", "--song", "../escape")["error"])

    def test_upload_sends_the_file_to_the_song(self):
        api = self.sign_in()
        song_id = self.first_track()
        mix = self.home / "My Mix (final).wav"
        mix.write_bytes(b"RIFF" + bytes(range(256)) * 64)

        result = self.agent("upload", "--song", song_id, "--file", str(mix))
        self.assertEqual(result["ok"], "true", result)
        self.assertEqual(result["upload"]["filename"], "My Mix (final).wav")
        [sent] = api.uploads
        self.assertEqual((sent["song"], sent["filename"], sent["body"], sent["content_type"]),
                         (song_id, "My Mix (final).wav", mix.read_bytes(), "application/octet-stream"))

    def test_upload_needs_an_existing_file(self):
        self.sign_in()
        result = self.agent("upload", "--song", "song-1", "--file", str(self.home / "missing.wav"))
        self.assertIn("--file", result["error"])

    def test_export_needs_a_daw_that_can_render(self):
        self.sign_in()
        song_id = self.first_track()
        for daw in ("ableton", "flstudio", "logic"):
            result = self.agent("export", "--daw", daw, "--song", song_id)
            self.assertEqual(result["ok"], "false")
            self.assertIn("can't render", result["error"])
        self.assertIn("Unknown DAW", self.agent("export", "--daw", "reaper", "--song", song_id)["error"])

    def test_unsafe_names_from_the_api_are_rejected(self):
        api = self.sign_in()
        stem = {"role": "x", "name": "X", "filename": "drums.wav", "url": "/v1/assets/drums.wav"}
        api.song_override = {"id": "../../escape", "title": "T", "assets": [stem]}
        self.assertIn("invalid song id", self.agent("download", "--song", "song-1")["error"])

        api.song_override = {"id": "song-x", "title": "T", "assets": [dict(stem, filename="../../escape.wav")]}
        self.assertIn("invalid file name", self.agent("download", "--song", "song-x")["error"])
        self.assertEqual(list(self.home.rglob("escape*")), [])


class TestBridges(AgentTestCase):
    def check_protocol(self, daw, tick):
        """tick(fail=False) runs one bridge poll and returns the paths the stub DAW imported."""
        manifest, stems = self.make_generation()
        bridge = Path(self.agent("health")["data_dir"]) / daw

        self.assertEqual(tick(), [])  # first poll only writes the heartbeat
        daws = {d["id"]: d for d in self.agent("daws")["daws"]}
        self.assertEqual(daws[daw]["bridge_ready"], "true")
        self.assertEqual(self.agent("import", "--daw", daw, "--manifest", str(manifest))["queued"], "true")

        self.assertEqual(tick(fail=True), [])
        self.assertTrue((bridge / "import.result").read_text().startswith("error\n"))
        self.assertTrue((bridge / "import.request").exists(), "a failed import must stay queued for a retry")

        self.assertEqual(tick(), stems)
        self.assertTrue((bridge / "import.result").read_text().startswith("ok\n"))
        self.assertFalse((bridge / "import.request").exists(), "a finished import must be consumed")
        self.assertEqual(tick(), [])

    def run_lua(self, daw, script, mode=""):
        """One bridge poll in the Lua harness; returns its output lines grouped by kind."""
        args = [LUA, str(ROOT / "tests" / "bridge_harness.lua"), daw, str(script)] + ([mode] if mode else [])
        out = subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        lines = {}
        for line in out.stdout.splitlines():
            kind, _, value = line.partition("\t")
            lines.setdefault(kind, []).append(value)
        return lines

    def export(self, daw, tick):
        """Runs `daw-agent export` while ticking the bridge; returns (agent result, uploads, every tick's output)."""
        api = self.sign_in()
        song_id = self.first_track()
        tick()  # heartbeat
        agent = subprocess.Popen([AGENT, "export", "--daw", daw, "--song", song_id], env=self.env,
                                 stdout=subprocess.PIPE, text=True)
        self.addCleanup(agent.kill)
        ticks, deadline = [], time.monotonic() + 30
        while agent.poll() is None and time.monotonic() < deadline:
            ticks.append(tick())
            time.sleep(0.1)
        result = json.loads(agent.communicate(timeout=10)[0])
        for upload in api.uploads:
            self.assertEqual(upload["song"], song_id)
        return result, api.uploads, ticks

    def check_render(self, daw, tick):
        """Exports through the bridge; returns the output of the poll that rendered."""
        result, uploads, ticks = self.export(daw, tick)
        self.assertEqual(result["ok"], "true", result)
        [render_tick] = [t for t in ticks if "RENDERED" in t]
        [rendered] = render_tick["RENDERED"]
        [sent] = uploads
        self.assertEqual(sent["filename"], Path(rendered).name)
        self.assertRegex(sent["filename"], rf"^{daw}-mix-\d{{8}}-\d{{6}}\.wav$")
        self.assertEqual(sent["body"], Path(rendered).read_bytes())
        self.assertFalse((Path(self.agent("health")["data_dir"]) / daw / "render.request").exists())
        return render_tick

    @unittest.skipUnless(LUA, "no lua interpreter on PATH")
    def test_ardour(self):
        self.dev_mode()
        script = self.install()["ardour"]
        self.check_protocol("ardour", lambda fail=False: self.run_lua("ardour", script, "fail" if fail else "").get("IMPORT", []))

    @unittest.skipUnless(LUA, "no lua interpreter on PATH")
    def test_reaper(self):
        self.dev_mode()
        script = self.install()["reaper"]
        self.check_protocol("reaper", lambda fail=False: self.run_lua("reaper", script, "fail" if fail else "").get("IMPORT", []))

    @unittest.skipUnless(LUA, "no lua interpreter on PATH")
    def test_ardour_renders_the_mix_for_upload(self):
        self.dev_mode()
        script = self.install()["ardour"]
        self.check_render("ardour", lambda: self.run_lua("ardour", script))

    @unittest.skipUnless(LUA, "no lua interpreter on PATH")
    def test_reaper_renders_the_mix_and_restores_render_settings(self):
        self.dev_mode()
        script = self.install()["reaper"]
        render_tick = self.check_render("reaper", lambda: self.run_lua("reaper", script))
        self.assertEqual(sorted(render_tick["SETTING"]), sorted([
            "RENDER_FILE\t/user/renders", "RENDER_PATTERN\tuser-pattern", "RENDER_FORMAT\tuser-format",
            "RENDER_SETTINGS\t4", "RENDER_BOUNDSFLAG\t2", "RENDER_ADDTOPROJ\t1"]))

    @unittest.skipUnless(LUA, "no lua interpreter on PATH")
    def test_render_failures_reach_the_user_and_upload_nothing(self):
        self.dev_mode()
        installed = self.install()
        for daw, mode, message in [("reaper", "fail", "stub DAW rejected the render"),
                                   ("ardour", "empty", "The session is empty")]:
            result, uploads, _ = self.export(daw, lambda: self.run_lua(daw, installed[daw], mode))
            self.assertEqual(result["ok"], "false")
            self.assertIn(message, result["error"])
            self.assertEqual(uploads, [])

    def test_ableton(self):
        script_dir = self.install()["ableton"]
        imported, failing = [], [False]

        class Track:
            name = ""

            def create_audio_clip(self, path, position):
                if failing[0]:
                    raise RuntimeError("stub Live rejected the clip")
                imported.append(path)
                self.position = position

        class Song:
            current_song_time = 16.0

            def __init__(self):
                self.tracks = []

            def create_audio_track(self, index):
                self.tracks.append(Track())

        class ControlSurface:
            def __init__(self, c_instance):
                self._song = Song()

            def song(self):
                return self._song

            def update_display(self):
                pass

        live = types.ModuleType("Live")
        live.Track = types.SimpleNamespace(Track=Track)
        control_surface = types.ModuleType("_Framework.ControlSurface")
        control_surface.ControlSurface = ControlSurface
        sys.modules.update({"Live": live, "_Framework": types.ModuleType("_Framework"),
                            "_Framework.ControlSurface": control_surface})
        sys.path.insert(0, str(script_dir.parent))
        self.addCleanup(sys.path.remove, str(script_dir.parent))
        bridge = importlib.import_module("AI_DAW_Bridge").AI_DAW_Bridge(None)

        def tick(fail=False):
            failing[0] = fail
            imported.clear()
            bridge._last_poll = 0
            bridge.update_display()
            return list(imported)

        self.check_protocol("ableton", tick)
        drums, bass = bridge.song().tracks[-2:]
        self.assertEqual((drums.name, bass.name), ("Drums", "Bass"))
        self.assertEqual((drums.position, bass.position), (16.0, 16.0))  # at the playhead

        # Live older than 12.0.5 has no create_audio_clip: clear error, no new tracks.
        live.Track = types.SimpleNamespace(Track=object)
        track_count = len(bridge.song().tracks)
        ok, message = bridge._import_generation({"assets": [{"name": "Drums", "path": "x.wav"}]})
        self.assertFalse(ok)
        self.assertIn("12.0.5", message)
        self.assertEqual(len(bridge.song().tracks), track_count)


if __name__ == "__main__":
    unittest.main(verbosity=2)
