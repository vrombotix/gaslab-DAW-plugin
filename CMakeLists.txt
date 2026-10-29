cmake_minimum_required(VERSION 3.20)
# std::filesystem needs macOS 10.15+; keep in sync with tauri.conf.json minimumSystemVersion.
set(CMAKE_OSX_DEPLOYMENT_TARGET "10.15" CACHE STRING "Minimum macOS version")
project(ai_daw_prototype LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Static CRT, matching vcpkg's x64-windows-static triplet, so the sidecar ships as one .exe.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

find_package(CURL REQUIRED)
# Only header-only Boost.PropertyTree is used, so find the headers rather than a Boost package config.
find_path(BOOST_INCLUDE_DIR boost/property_tree/ptree.hpp REQUIRED)

add_library(aidaudio STATIC
  native/core/src/PlatformPaths.cpp
  native/adapters/src/ArdourAdapter.cpp
  native/adapters/src/BridgeRender.cpp
  native/adapters/src/ReaperAdapter.cpp
  native/adapters/src/AbletonAdapter.cpp
  native/adapters/src/FLStudioAdapter.cpp
  native/adapters/src/LogicAdapter.cpp
)
target_include_directories(aidaudio PUBLIC native/core/include native/adapters/include)

add_executable(daw-agent native/agent/src/main.cpp)
target_include_directories(daw-agent PRIVATE ${BOOST_INCLUDE_DIR})
target_link_libraries(daw-agent PRIVATE aidaudio CURL::libcurl)

enable_testing()
add_executable(aidaudio-tests native/tests/adapters_test.cpp)
find_package(Threads REQUIRED)
target_link_libraries(aidaudio-tests PRIVATE aidaudio Threads::Threads)
add_test(NAME adapters COMMAND aidaudio-tests)

find_package(Python3 COMPONENTS Interpreter)
if(Python3_FOUND)
  add_test(NAME agent COMMAND ${Python3_EXECUTABLE} ${CMAKE_SOURCE_DIR}/tests/test_agent.py)
  set_tests_properties(agent PROPERTIES ENVIRONMENT "DAW_AGENT=$<TARGET_FILE:daw-agent>")
endif()
