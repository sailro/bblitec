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

# Native GPU render backend selection. BOTH compiles the dual-backend
# development binary (the differential gate); SDL_GPU and DAWN produce
# single-backend release shapes whose runtime payloads follow the
# compiled set (offline DXIL/SPIR-V versus WGSL text, Dawn DLLs).
set(
    BBLITE_BACKEND
    "SDL_GPU"
    CACHE STRING
    "Native GPU render backend set: SDL_GPU, DAWN, or BOTH"
)
set_property(
    CACHE BBLITE_BACKEND
    PROPERTY STRINGS "SDL_GPU" "DAWN" "BOTH"
)
if(BBLITE_BACKEND STREQUAL "SDL_GPU")
    set(BBLITE_BACKEND_SDL_GPU ON)
    set(BBLITE_BACKEND_DAWN OFF)
elseif(BBLITE_BACKEND STREQUAL "DAWN")
    set(BBLITE_BACKEND_SDL_GPU OFF)
    set(BBLITE_BACKEND_DAWN ON)
elseif(BBLITE_BACKEND STREQUAL "BOTH")
    set(BBLITE_BACKEND_SDL_GPU ON)
    set(BBLITE_BACKEND_DAWN ON)
else()
    message(
        FATAL_ERROR
        "BBLITE_BACKEND must be SDL_GPU, DAWN, or BOTH (got '${BBLITE_BACKEND}')."
    )
endif()
if(NOT BBLITE_BACKEND_SDL_GPU)
    list(
        REMOVE_ITEM
        BBLITE_RUNTIME_SOURCES
        "${BBLITE_NATIVE_ROOT}/src/pal_sdl_gpu.cpp"
    )
endif()

add_executable(
    bblite_native
    "${BBLITE_GENERATED_DIR}/main.cpp"
    ${BBLITE_RUNTIME_SOURCES}
    ${BBLITE_GENERATED_SOURCES}
)

if(BBLITE_GENERATED_SHADER_FILES)
    set(
        BBLITE_SHADER_LINK_SOURCE
        "${CMAKE_CURRENT_BINARY_DIR}/bblite-shader-link.cpp"
    )
    add_custom_command(
        OUTPUT
            "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
            "${BBLITE_SHADER_LINK_SOURCE}"
        COMMAND "${CMAKE_COMMAND}" -E remove_directory "${BBLITE_BUILD_SHADER_DIR}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${BBLITE_BUILD_SHADER_DIR}"
        COMMAND
            "${CMAKE_COMMAND}" -E copy_directory
            "${BBLITE_GENERATED_SHADER_DIR}"
            "${BBLITE_BUILD_SHADER_DIR}"
        COMMAND
            "${CMAKE_COMMAND}" -E touch
            "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
        COMMAND
            "${CMAKE_COMMAND}" -E touch
            "${BBLITE_SHADER_LINK_SOURCE}"
        DEPENDS ${BBLITE_GENERATED_SHADER_FILES}
        VERBATIM
    )
    set_source_files_properties(
        "${BBLITE_SHADER_LINK_SOURCE}"
        PROPERTIES GENERATED TRUE
    )
    target_sources(
        bblite_native
        PRIVATE "${BBLITE_SHADER_LINK_SOURCE}"
    )
    add_custom_target(
        bblite_shader_snapshot
        DEPENDS
            "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
            "${BBLITE_SHADER_LINK_SOURCE}"
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
target_compile_definitions(bblite_native PRIVATE BBLITE_ASSET_DIR="assets")
target_compile_definitions(bblite_native PRIVATE BBLITE_GPU_SHADER_DIR="shaders")

if(EXISTS "${BBLITE_GENERATED_DIR}/assets")
    add_custom_command(
        TARGET bblite_native
        POST_BUILD
        COMMAND
            "${CMAKE_COMMAND}" -E remove_directory
            "$<TARGET_FILE_DIR:bblite_native>/assets"
        COMMAND
            "${CMAKE_COMMAND}" -E copy_directory
            "${BBLITE_GENERATED_DIR}/assets"
            "$<TARGET_FILE_DIR:bblite_native>/assets"
        VERBATIM
    )
endif()

if(BBLITE_GENERATED_SHADER_FILES)
    add_custom_command(
        TARGET bblite_native
        POST_BUILD
        COMMAND
            "${CMAKE_COMMAND}" -E remove_directory
            "$<TARGET_FILE_DIR:bblite_native>/shaders"
        COMMAND
            "${CMAKE_COMMAND}" -E copy_directory
            "${BBLITE_BUILD_SHADER_DIR}"
            "$<TARGET_FILE_DIR:bblite_native>/shaders"
        VERBATIM
    )
endif()

find_package(SDL3 CONFIG QUIET)
if(SDL3_FOUND)
    target_link_libraries(bblite_native PRIVATE SDL3::SDL3)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL=0)
    message(WARNING "SDL3 was not found. The generated application will use the headless backend.")
endif()

if(BBLITE_BACKEND_SDL_GPU)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL_GPU=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_SDL_GPU=0)
endif()

if(BBLITE_BACKEND_DAWN)
    find_package(
        Dawn CONFIG REQUIRED
        PATHS "${BBLITE_NATIVE_ROOT}/../artifacts/tools/dawn/lib/cmake/Dawn"
        NO_DEFAULT_PATH
    )
    target_sources(
        bblite_native
        PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_dawn.cpp"
    )
    target_link_libraries(bblite_native PRIVATE dawn::webgpu_dawn)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_DAWN=1)
    # Dawn's hardened DLL search resolves FXC (d3dcompiler_47.dll)
    # relative to the loaded module, matching how Chrome deploys the
    # SDK compiler beside chrome.dll.
    add_custom_command(
        TARGET bblite_native POST_BUILD
        COMMAND
            "${CMAKE_COMMAND}" -E copy_if_different
            "$<TARGET_FILE:dawn::webgpu_dawn>"
            "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/d3dcompiler_47.dll"
            "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxcompiler.dll"
            "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxil.dll"
            "$<TARGET_FILE_DIR:bblite_native>"
        VERBATIM
    )
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_DAWN=0)
endif()

if("renderer:pbr" IN_LIST BBLITE_RUNTIME_FEATURES)
    if("renderer:transmission" IN_LIST BBLITE_RUNTIME_FEATURES)
        target_compile_definitions(
            bblite_native
            PRIVATE BBLITE_RENDERER_TRANSMISSION=1
        )
    endif()
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

if("renderer:geometry-output" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_GEOMETRY_OUTPUT=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_GEOMETRY_OUTPUT=0
    )
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
