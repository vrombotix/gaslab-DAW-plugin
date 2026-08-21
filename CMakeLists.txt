cmake_minimum_required(VERSION 3.20)
project(ai_daw_prototype LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(PkgConfig REQUIRED)
pkg_check_modules(CURL REQUIRED libcurl)

add_executable(daw-agent
  native/agent/src/main.cpp
  native/adapters/src/ArdourAdapter.cpp
)

target_include_directories(daw-agent PRIVATE
  native/core/include
  native/adapters/include
  ${CURL_INCLUDE_DIRS}
)

target_link_directories(daw-agent PRIVATE ${CURL_LIBRARY_DIRS})
target_link_libraries(daw-agent PRIVATE ${CURL_LIBRARIES})
target_compile_options(daw-agent PRIVATE ${CURL_CFLAGS_OTHER})
