ardour {
  ["type"] = "EditorHook",
  name = "AI DAW Import Bridge",
  author = "AI DAW Prototype",
  description = [[Watches for AI DAW import requests and imports generated stems as separate tracks.]]
}

function signals()
  local s = LuaSignal.Set()
  s:add({
    [LuaSignal.LuaTimerS] = true
  })
  return s
end

-- Everything the returned callback needs must be defined inside factory()
-- itself: Ardour instantiates factory() as a self-contained unit, so
-- helper functions/state declared at the file's top level are not
-- reliably visible from inside it (observed as "attempt to call a table
-- value" / "attempt to call a nil value" for top-level helpers).
function factory()

  local tick = 0
  local last_generation_id = ""

  local function get_bridge_dir()
    local home = os.getenv("HOME") or "/tmp"
    return home .. "/.local/share/ai-daw-prototype/ardour"
  end

  local bridge_dir = get_bridge_dir()

  local request_path =
    bridge_dir .. "/import.request"

  local status_path =
    bridge_dir .. "/bridge.status"

  local result_path =
    bridge_dir .. "/import.result"

  local function read_request(path)
    local f = io.open(path, "r")
    if not f then
      return nil
    end

    local req = {
      generation_id = "",
      assets = {}
    }

    for line in f:lines() do
      local k, v = string.match(line, "^([^=]+)=(.*)$")

      if k == "generation_id" then
        req.generation_id = v

      elseif k == "asset" then
        local name, filepath =
          string.match(v, "^([^\t]+)\t(.+)$")

        if name and filepath then
          table.insert(req.assets, {
            name = name,
            path = filepath
          })
        end
      end
    end

    f:close()
    return req
  end

  local function write_status(path)
    local f = io.open(path, "w")
    if not f then
      return
    end

    f:write("ready\n")
    f:write("session=" .. Session:name() .. "\n")
    f:write("tick=" .. tostring(tick) .. "\n")
    f:close()
  end

  local function write_result(path, ok, message)
    local f = io.open(path, "w")
    if not f then
      return
    end

    if ok then
      f:write("ok\n")
    else
      f:write("error\n")
    end

    f:write(message or "")
    f:write("\n")
    f:close()
  end

  local function import_generation(req)
    if not req then
      return false, "Invalid request"
    end

    if #req.assets == 0 then
      return false, "No assets in request"
    end

    local files = C.StringVector()

    for _, asset in ipairs(req.assets) do
      files:push_back(asset.path)
    end

    local position =
      Temporal.timepos_t(Session:transport_sample())

    local ok, err = pcall(function()

      Editor:do_import(
        files,
        Editing.ImportDistinctFiles,
        Editing.ImportAsTrack,
        ARDOUR.SrcQuality.SrcBest,
        ARDOUR.MidiTrackNameSource.SMFTrackName,
        ARDOUR.MidiTempoMapDisposition.SMFTempoIgnore,
        position,
        ARDOUR.PluginInfo(),
        ARDOUR.Track(),
        false
      )

    end)

    if not ok then
      return false, tostring(err)
    end

    return true,
      "Imported " .. tostring(#req.assets) .. " stems"
  end

  return function(signal, ...)

    tick = tick + 1

    write_status(status_path)

    local req = read_request(request_path)

    if not req then
      return
    end

    if req.generation_id == "" then
      return
    end

    -- Prevent importing the same request every timer tick.
    if req.generation_id == last_generation_id then
      return
    end

    local ok, message =
      import_generation(req)

    -- Only mark this generation as handled once it actually succeeds,
    -- so a failed import gets retried on the next tick instead of
    -- being silently skipped forever.
    if ok then
      last_generation_id = req.generation_id
    end

    write_result(
      result_path,
      ok,
      message
    )

    write_status(status_path)
  end
end
