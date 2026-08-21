ardour {
  ["type"] = "EditorHook",
  name = "AI DAW Import Bridge",
  author = "AI DAW Prototype",
  description = [[Watches for import requests from the AI DAW desktop agent and imports generated WAV stems at the current playhead as new Ardour tracks. Prototype bridge.]],
}

local HOME = os.getenv("HOME") or "/tmp"
local BRIDGE_DIR = HOME .. "/.local/share/ai-daw-prototype/ardour"
local REQUEST = BRIDGE_DIR .. "/import.request"
local STATUS = BRIDGE_DIR .. "/bridge.status"
local RESULT = BRIDGE_DIR .. "/import.result"
local tick = 0
os.execute('mkdir -p "' .. BRIDGE_DIR .. '"')

function signals()
  local s = LuaSignal.Set()
  s:add({ [LuaSignal.LuaTimerDS] = true })
  return s
end

local function write_status()
  local f = io.open(STATUS, "w")
  if not f then return end
  f:write("ready\n")
  f:write("session=" .. Session:name() .. "\n")
  f:write("time=" .. tostring(os.time()) .. "\n")
  f:close()
end

local function write_result(ok, text)
  local f = io.open(RESULT, "w")
  if not f then return end
  f:write(ok and "ok\n" or "error\n")
  f:write(text or "")
  f:write("\n")
  f:close()
end

local function read_request()
  local f = io.open(REQUEST, "r")
  if not f then return nil end
  local assets = {}
  local generation_id = "unknown"
  for line in f:lines() do
    local k, v = line:match("^([^=]+)=(.*)$")
    if k == "generation_id" then
      generation_id = v
    elseif k == "asset" then
      local name, path = v:match("^([^\t]+)\t(.+)$")
      if name and path then table.insert(assets, { name = name, path = path }) end
    end
  end
  f:close()
  return { generation_id = generation_id, assets = assets }
end

local function import_request(req)
  if not req or #req.assets == 0 then return false, "No assets in request" end
  if Session:transport_rolling() then
    Session:request_stop(true, false, ARDOUR.TransportRequestSource.TRS_UI)
  end

  local files = ARDOUR.LuaAPI.CppStringVector()
  for _, asset in ipairs(req.assets) do
    files:push_back(asset.path)
  end

  local Editing = LuaAPI.Editing
  local position = Temporal.timepos_t(Session:transport_sample())

  local ok, err = pcall(function()
    -- ImportDistinctFiles + ImportAsTrack is Ardour's native "each file as a
    -- separate new track" operation. All files use the same playhead position.
    Editor:do_import(
      files,
      Editing.ImportDistinctFiles,
      Editing.ImportAsTrack,
      ARDOUR.SrcQuality.SrcBest,
      ARDOUR.MidiTrackNameSource.SMFTrackName,
      ARDOUR.MidiTempoMapDisposition.SMFTempoIgnore,
      position,
      ARDOUR.PluginInfo(),
      nil,
      false
    )
  end)

  if ok then return true, "Imported " .. tostring(#req.assets) .. " stems" end
  return false, tostring(err)
end

function factory()
  return function(signal, ...)
    tick = tick + 1
    if tick % 10 == 0 then write_status() end

    local f = io.open(REQUEST, "r")
    if not f then return end
    f:close()

    local req = read_request()
    -- Claim the request before importing so the 100ms timer cannot import twice.
    os.rename(REQUEST, REQUEST .. ".processing")
    local ok, message = import_request(req)
    os.remove(REQUEST .. ".processing")
    write_result(ok, message)
    write_status()
  end
end
