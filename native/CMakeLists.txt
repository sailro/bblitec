cmake_minimum_required(VERSION 3.24)

project(babylon_lite_native LANGUAGES CXX)

set(BBLITE_GENERATED_DIR "" CACHE PATH "Directory produced by bblitec")
if(NOT BBLITE_GENERATED_DIR)
    message(FATAL_ERROR "Set BBLITE_GENERATED_DIR to a directory containing main.cpp and features.cmake.")
endif()

get_filename_component(BBLITE_GENERATED_DIR "${BBLITE_GENERATED_DIR}" ABSOLUTE)
set(BBLITE_NATIVE_ROOT "${CMAKE_CURRENT_LIST_DIR}")
include("${BBLITE_GENERATED_DIR}/features.cmake")

set(BBLITE_GENERATED_SHADER_DIR "${BBLITE_GENERATED_DIR}/upstream/shaders")
set(BBLITE_BUILD_SHADER_DIR "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders")
file(
    GLOB_RECURSE BBLITE_GENERATED_SHADER_FILES
    CONFIGURE_DEPENDS
    LIST_DIRECTORIES false
    "${BBLITE_GENERATED_SHADER_DIR}/*"
)

add_executable(
    bblite_native
    "${BBLITE_GENERATED_DIR}/main.cpp"
    ${BBLITE_RUNTIME_SOURCES}
    ${BBLITE_GENERATED_SOURCES}
)

if(BBLITE_GENERATED_SHADER_FILES)
    add_custom_command(
        OUTPUT "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
        COMMAND "${CMAKE_COMMAND}" -E remove_directory "${BBLITE_BUILD_SHADER_DIR}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${BBLITE_BUILD_SHADER_DIR}"
        COMMAND
            "${CMAKE_COMMAND}" -E copy_directory
            "${BBLITE_GENERATED_SHADER_DIR}"
            "${BBLITE_BUILD_SHADER_DIR}"
        COMMAND
            "${CMAKE_COMMAND}" -E touch
            "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
        DEPENDS ${BBLITE_GENERATED_SHADER_FILES}
        VERBATIM
    )
    add_custom_target(
        bblite_shader_snapshot
        DEPENDS "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
    )
    add_dependencies(bblite_native bblite_shader_snapshot)
endif()

target_compile_features(bblite_native PRIVATE cxx_std_20)
target_include_directories(
    bblite_native
    PRIVATE
    "${BBLITE_NATIVE_ROOT}/include"
    "${BBLITE_GENERATED_DIR}/upstream/include"
)
target_compile_definitions(bblite_native PRIVATE BBLITE_ASSET_DIR="${BBLITE_GENERATED_DIR}/assets")
target_compile_definitions(bblite_native PRIVATE BBLITE_GPU_SHADER_DIR="${BBLITE_BUILD_SHADER_DIR}")

find_package(SDL3 CONFIG QUIET)
if(SDL3_FOUND)
    target_link_libraries(bblite_native PRIVATE SDL3::SDL3)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL=0)
    message(WARNING "SDL3 was not found. The generated application will use the headless backend.")
endif()

if("renderer:pbr" IN_LIST BBLITE_RUNTIME_FEATURES)
    if(SDL3_FOUND)
        find_package(SDL3_image CONFIG REQUIRED)
        target_link_libraries(
            bblite_native
            PRIVATE
            $<IF:$<TARGET_EXISTS:SDL3_image::SDL3_image-shared>,SDL3_image::SDL3_image-shared,SDL3_image::SDL3_image-static>
        )
    endif()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PBR_RENDERER=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PBR_RENDERER=0)
endif()

if(
    "loader:gltf" IN_LIST BBLITE_RUNTIME_FEATURES OR
    "loader:babylon" IN_LIST BBLITE_RUNTIME_FEATURES
)
    find_package(nlohmann_json CONFIG REQUIRED)
    target_link_libraries(bblite_native PRIVATE nlohmann_json::nlohmann_json)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_GLTF=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_GLTF=0)
endif()

if(MSVC)
    target_compile_options(bblite_native PRIVATE /W4 /permissive- /EHsc)
else()
    target_compile_options(bblite_native PRIVATE -Wall -Wextra -Wpedantic)
endif()

message(STATUS "Babylon Lite native features: ${BBLITE_RUNTIME_FEATURES}")
