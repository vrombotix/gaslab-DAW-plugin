-- AI DAW Import Bridge for REAPER (ReaScript).
--
-- UNVERIFIED: written against the documented ReaScript API but never run
-- against a real REAPER install. reaper.InsertMedia()'s exact mode value
-- for "each file as its own new track" in particular should be confirmed
-- before relying on this.
--
-- Install: `daw-agent install-bridges` (run by the desktop app on startup)
-- copies this file into REAPER's Scripts folder and adds a dofile() line for
-- it to Scripts/__startup.lua, which REAPER runs on every start - no manual
-- per-project enable step, unlike the Ardour bridge.
--
-- Protocol: identical to integrations/ardour/ai_daw_import_bridge.lua -
-- same import.request / bridge.status / import.result files and format,
-- just under a "reaper" subdirectory instead of "ardour".

local last_generation_id = ""

-- Replaced with the real per-OS path by `daw-agent install-bridges`.
local BRIDGE_DIR = "@AI_DAW_BRIDGE_DIR@"

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
      local name, filepath = string.match(v, "^([^\t]+)\t(.+)$")
      if name and filepath then
        table.insert(req.assets, { name = name, path = filepath })
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
  f:write("time=" .. tostring(os.time()) .. "\n")
  f:close()
end

local function write_result(path, ok, message)
  local f = io.open(path, "w")
  if not f then
    return
  end
  f:write(ok and "ok\n" or "error\n")
  f:write(message or "")
  f:write("\n")
  f:close()
end

local function import_generation(req)
  if not req or #req.assets == 0 then
    return false, "No assets in request"
  end

  local ok, err = pcall(function()
    for _, asset in ipairs(req.assets) do
      -- mode 1: insert the file as a new track. Unverified against a real
      -- REAPER install - confirm this is the intended mode before relying
      -- on it in production.
      reaper.InsertMedia(asset.path, 1)
    end
  end)

  if not ok then
    return false, tostring(err)
  end

  return true, "Imported " .. tostring(#req.assets) .. " stems"
end

-- Render protocol (dev mode): the agent writes render.request with
-- request_id/folder/name; the bridge renders the master mix of the whole
-- project to <folder>/<name>.wav and answers in render.result.
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

-- The project render settings this bridge changes. They are saved first and
-- restored afterwards, so the user's own render setup stays as it was.
local RENDER_STRINGS = { "RENDER_FILE", "RENDER_PATTERN", "RENDER_FORMAT" }
local RENDER_NUMBERS = { "RENDER_SETTINGS", "RENDER_BOUNDSFLAG", "RENDER_ADDTOPROJ" }

local function render_mix(req)
  local saved_strings, saved_numbers = {}, {}
  for _, key in ipairs(RENDER_STRINGS) do
    local _, value = reaper.GetSetProjectInfo_String(0, key, "", false)
    saved_strings[key] = value
  end
  for _, key in ipairs(RENDER_NUMBERS) do
    saved_numbers[key] = reaper.GetSetProjectInfo(0, key, 0, false)
  end

  local ok, err = pcall(function()
    reaper.GetSetProjectInfo_String(0, "RENDER_FILE", req.folder, true)
    reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", req.name, true)
    reaper.GetSetProjectInfo_String(0, "RENDER_FORMAT", "evaw", true) -- WAV, default settings
    reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 0, true) -- master mix
    reaper.GetSetProjectInfo(0, "RENDER_BOUNDSFLAG", 1, true) -- entire project
    reaper.GetSetProjectInfo(0, "RENDER_ADDTOPROJ", 0, true) -- don't add the render to the project
    -- File: Render project, using the most recent render settings, auto-close
    -- render dialog. Blocks until the render is done.
    reaper.Main_OnCommand(42230, 0)
  end)

  for key, value in pairs(saved_strings) do
    reaper.GetSetProjectInfo_String(0, key, value, true)
  end
  for key, value in pairs(saved_numbers) do
    reaper.GetSetProjectInfo(0, key, value, true)
  end

  if not ok then
    return false, tostring(err)
  end
  local path = req.folder .. "/" .. req.name .. ".wav"
  local f = io.open(path, "rb")
  if not f then
    return false, "REAPER did not write " .. path .. " (is the project empty?)"
  end
  f:close()
  return true, path
end

local function loop()
  local bridge_dir = BRIDGE_DIR
  local request_path = bridge_dir .. "/import.request"
  local status_path = bridge_dir .. "/bridge.status"
  local result_path = bridge_dir .. "/import.result"

  write_status(status_path)

  local req = read_request(request_path)

  if req and req.generation_id ~= "" and req.generation_id ~= last_generation_id then
    local ok, message = import_generation(req)
    if ok then
      last_generation_id = req.generation_id
      -- Consume the request so a future REAPER/script restart (which
      -- starts last_generation_id fresh) can't replay an old import.
      os.remove(request_path)
    end
    write_result(result_path, ok, message)
    write_status(status_path)
  end

  local render_request_path = bridge_dir .. "/render.request"
  local render_req = read_render_request(render_request_path)
  if render_req and render_req.request_id and render_req.folder and render_req.name then
    -- Consumed before rendering, so a crash mid-render can't loop forever.
    os.remove(render_request_path)
    local ok, message = render_mix(render_req)
    write_render_result(bridge_dir .. "/render.result", render_req.request_id, ok, message)
    write_status(status_path)
  end

  reaper.defer(loop)
end

loop()
