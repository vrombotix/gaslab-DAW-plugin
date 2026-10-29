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

  -- Replaced with the real per-OS path by `daw-agent install-bridges`.
  local bridge_dir = "@AI_DAW_BRIDGE_DIR@"

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

  -- Render protocol (dev mode): the agent writes render.request with
  -- request_id/folder/name; the bridge exports the whole session to
  -- <folder>/<name>.wav and answers in render.result.
  local function read_render_request(path)
    local f = io.open(path, "r")
    if not f then
      return nil
    end
    local req = {}
    for line in f:lines() do
      local k, v = string.match(line, "^([^=]+)=(.*)$")
      if k then
        req[k] = v
      end
    end
    f:close()
    return req
  end

  -- Written to a temp file and renamed into place: the agent polls for it.
  local function write_render_result(path, request_id, ok, message)
    local f = io.open(path .. ".tmp", "w")
    if not f then
      return
    end
    f:write(request_id .. "\n" .. (ok and "ok" or "error") .. "\n" .. (message or "") .. "\n")
    f:close()
    os.remove(path)
    os.rename(path .. ".tmp", path)
  end

  local function render_mix(req)
    local first, last = Session:current_start_sample(), Session:current_end_sample()
    if last <= first then
      return false, "The session is empty - nothing to render."
    end
    local export = Session:simple_export()
    export:set_name(req.name)
    export:set_folder(req.folder)
    export:set_range(first, last)
    -- Ardour's bundled "WAV @ session-rate" export preset.
    if not export:set_preset("75969a1c-3133-4694-864b-a1fa50e43348") then
      return false, "Ardour's \"WAV @ session-rate\" export preset is missing."
    end
    if not export:check_outputs() then
      return false, "The session has no master output to export."
    end
    -- Blocks until the export file is written.
    if not export:run_export() then
      return false, "Ardour's export failed."
    end
    return true, req.folder .. "/" .. req.name .. ".wav"
  end

  return function(signal, ...)

    tick = tick + 1

    write_status(status_path)

    local render_request_path = bridge_dir .. "/render.request"
    local render_req = read_render_request(render_request_path)
    if render_req and render_req.request_id and render_req.folder and render_req.name then
      -- Consumed before rendering, so a crash mid-render can't loop forever.
      os.remove(render_request_path)
      local ok, result, message = pcall(render_mix, render_req)
      if not ok then
        result, message = false, tostring(result)
      end
      write_render_result(bridge_dir .. "/render.result", render_req.request_id, result, message)
      write_status(status_path)
    end

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
      -- Consume the request so it can never be replayed by a *future*
      -- Ardour/hook restart, which starts last_generation_id fresh at ""
      -- and would otherwise treat a long-finished request as brand new.
      os.remove(request_path)
    end

    write_result(
      result_path,
      ok,
      message
    )

    write_status(status_path)
  end
end
