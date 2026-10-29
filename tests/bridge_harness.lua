-- Runs one poll of an installed Lua bridge against stubbed DAW APIs, for
-- tests/test_agent.py (which checks the files the bridge reads and writes).
--
-- Usage: lua bridge_harness.lua <ardour|reaper> <installed bridge script> [fail|empty]
-- Prints one tab-separated line per thing the bridge asked the DAW to do:
--   IMPORT <path>        a file to import
--   RENDERED <path>      a mixdown the stub DAW wrote
--   SETTING <key> <val>  (REAPER) project render settings after the poll
-- "fail": the stub DAW rejects imports and renders. "empty": (Ardour) the
-- session has no range to render.
local daw, script, mode = arg[1], arg[2], arg[3]

local function import(path)
  if mode == "fail" then error("stub DAW rejected the import") end
  print("IMPORT\t" .. path)
end

local function render(path)
  if mode == "fail" then error("stub DAW rejected the render") end
  local f = assert(io.open(path, "wb"))
  f:write("RIFF-stub-mixdown")
  f:close()
  print("RENDERED\t" .. path)
end

if daw == "reaper" then
  local resource = script:match("^(.*)[/\\]Scripts[/\\][^/\\]+$")
  -- The user's own render setup, which the bridge must restore after rendering.
  local settings = {
    RENDER_FILE = "/user/renders", RENDER_PATTERN = "user-pattern", RENDER_FORMAT = "user-format",
    RENDER_SETTINGS = 4, RENDER_BOUNDSFLAG = 2, RENDER_ADDTOPROJ = 1,
  }
  reaper = {
    GetResourcePath = function() return resource end,
    InsertMedia = function(path) import(path) end,
    defer = function() end, -- one poll per harness run
    GetSetProjectInfo_String = function(_, key, value, is_set)
      if is_set then settings[key] = value end
      return true, settings[key]
    end,
    GetSetProjectInfo = function(_, key, value, is_set)
      if is_set then settings[key] = value end
      return settings[key]
    end,
    Main_OnCommand = function(command)
      assert(command == 42230, "unexpected action " .. tostring(command))
      assert(settings.RENDER_FORMAT == "evaw" and settings.RENDER_SETTINGS == 0 and settings.RENDER_BOUNDSFLAG == 1,
        "render settings were not applied")
      render(settings.RENDER_FILE .. "/" .. settings.RENDER_PATTERN .. ".wav")
    end,
  }
  -- Load through __startup.lua, as REAPER does.
  dofile(resource .. "/Scripts/__startup.lua")
  for _, key in ipairs({ "RENDER_FILE", "RENDER_PATTERN", "RENDER_FORMAT", "RENDER_SETTINGS", "RENDER_BOUNDSFLAG", "RENDER_ADDTOPROJ" }) do
    print("SETTING\t" .. key .. "\t" .. tostring(settings[key]))
  end
else
  -- Anything the Ardour bridge only passes through (enums, PluginInfo, ...).
  local any = setmetatable({}, { __index = function(t) return t end, __call = function(t) return t end })
  ARDOUR, Editing, Temporal = any, any, any
  function ardour() end
  Session = {
    name = function() return "Test Session" end,
    transport_sample = function() return 0 end,
    current_start_sample = function() return 0 end,
    current_end_sample = function() return mode == "empty" and 0 or 96000 end,
    simple_export = function()
      local export = {}
      function export:set_name(name) self.name = name end
      function export:set_folder(folder) self.folder = folder end
      function export:set_range(first, last) assert(last > first) end
      function export:set_preset(uuid) return uuid == "75969a1c-3133-4694-864b-a1fa50e43348" end
      function export:check_outputs() return true end
      function export:run_export()
        render(self.folder .. "/" .. self.name .. ".wav")
        return true
      end
      return export
    end,
  }
  C = {
    StringVector = function()
      local v = {}
      function v:push_back(s) self[#self + 1] = s end
      return v
    end,
  }
  Editor = {
    do_import = function(_, files)
      for _, path in ipairs(files) do import(path) end
    end,
  }
  dofile(script)
  factory()()
end
