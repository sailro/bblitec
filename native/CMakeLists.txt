cmake_minimum_required(VERSION 3.24)

project(babylon_lite_native LANGUAGES CXX)

set(BBLITE_GENERATED_DIR "" CACHE PATH "Directory produced by bblitec")
if(NOT BBLITE_GENERATED_DIR)
    message(FATAL_ERROR "Set BBLITE_GENERATED_DIR to a directory containing main.cpp and features.cmake.")
endif()

get_filename_component(BBLITE_GENERATED_DIR "${BBLITE_GENERATED_DIR}" ABSOLUTE)
set(BBLITE_NATIVE_ROOT "${CMAKE_CURRENT_LIST_DIR}")
include("${BBLITE_GENERATED_DIR}/features.cmake")

add_executable(
    bblite_native
    "${BBLITE_GENERATED_DIR}/main.cpp"
    ${BBLITE_RUNTIME_SOURCES}
)

target_compile_features(bblite_native PRIVATE cxx_std_20)
target_include_directories(bblite_native PRIVATE "${BBLITE_NATIVE_ROOT}/include")
target_compile_definitions(bblite_native PRIVATE BBLITE_ASSET_DIR="${BBLITE_GENERATED_DIR}/assets")

find_package(SDL3 CONFIG QUIET)
if(SDL3_FOUND)
    target_link_libraries(bblite_native PRIVATE SDL3::SDL3)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL=0)
    message(WARNING "SDL3 was not found. The generated application will use the headless backend.")
endif()

if("loader:gltf" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_path(CGLTF_INCLUDE_DIRS "cgltf.h" REQUIRED)
    target_include_directories(bblite_native PRIVATE ${CGLTF_INCLUDE_DIRS})
    if(SDL3_FOUND)
        find_package(SDL3_image CONFIG REQUIRED)
        target_link_libraries(
            bblite_native
            PRIVATE
            $<IF:$<TARGET_EXISTS:SDL3_image::SDL3_image-shared>,SDL3_image::SDL3_image-shared,SDL3_image::SDL3_image-static>
        )
    endif()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_GLTF=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_GLTF=0)
endif()

if(MSVC)
    target_compile_options(bblite_native PRIVATE /W4 /permissive-)
else()
    target_compile_options(bblite_native PRIVATE -Wall -Wextra -Wpedantic)
endif()

message(STATUS "Babylon Lite native features: ${BBLITE_RUNTIME_FEATURES}")
