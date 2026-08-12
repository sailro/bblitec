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

# Minimal-size release shape: whole-program optimization and
# dead-stripping for the executable. Pair with the vcpkg
# x64-windows-static triplet (static SDL/image/CRT) and, for Dawn,
# BBLITE_DAWN_DIR pointing at a tools/build-dawn-min.ps1 install so
# the whole payload folds into one executable.
option(
    BBLITE_MINSIZE
    "Optimize the executable for minimal size (LTCG, dead-stripping)"
    OFF
)

# Installed pinned Dawn package root. The default is the differential-
# gate library (tools/build-dawn.ps1, shared + built DXC); minimal
# builds point this at artifacts/tools/dawn-min.
set(
    BBLITE_DAWN_DIR
    "${BBLITE_NATIVE_ROOT}/../artifacts/tools/dawn"
    CACHE PATH
    "Installed pinned Dawn library root"
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
        PATHS "${BBLITE_DAWN_DIR}/lib/cmake/Dawn"
        NO_DEFAULT_PATH
    )
    # The static monolithic Dawn export references Threads::Threads,
    # which DawnConfig.cmake does not resolve itself.
    find_package(Threads REQUIRED)
    # Installed Dawn packages carry a single configuration (Release for
    # the shared differential-gate library, MinSizeRel for the minimal
    # static one); map every consumer configuration onto whichever
    # exists so multi-config generators can generate all of them.
    set_target_properties(
        dawn::webgpu_dawn
        PROPERTIES
        MAP_IMPORTED_CONFIG_RELEASE "Release;MinSizeRel;RelWithDebInfo"
        MAP_IMPORTED_CONFIG_RELWITHDEBINFO "RelWithDebInfo;Release;MinSizeRel"
        MAP_IMPORTED_CONFIG_MINSIZEREL "MinSizeRel;Release;RelWithDebInfo"
        MAP_IMPORTED_CONFIG_DEBUG "Debug;Release;MinSizeRel;RelWithDebInfo"
    )
    target_sources(
        bblite_native
        PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_dawn.cpp"
    )
    target_link_libraries(bblite_native PRIVATE dawn::webgpu_dawn)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_DAWN=1)
    get_target_property(BBLITE_DAWN_LIBRARY_TYPE dawn::webgpu_dawn TYPE)
    if(BBLITE_DAWN_LIBRARY_TYPE STREQUAL "SHARED_LIBRARY")
        # Dawn resolves its built DXC DLLs relative to the loaded
        # module, matching how Chrome deploys them beside chrome.dll.
        # FXC (d3dcompiler_47.dll) is not deployed: the PAL preloads it
        # from the executable directory or System32, so only an
        # intentionally placed SDK copy ever ships. A static Dawn
        # deploys no DLLs at all.
        add_custom_command(
            TARGET bblite_native POST_BUILD
            COMMAND
                "${CMAKE_COMMAND}" -E copy_if_different
                "$<TARGET_FILE:dawn::webgpu_dawn>"
                "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxcompiler.dll"
                "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxil.dll"
                "$<TARGET_FILE_DIR:bblite_native>"
            VERBATIM
        )
    endif()
    # Whether the installed Dawn carries its built DXC
    # (tools/build-dawn.ps1 deploys dxcompiler.dll into bin; the
    # minimal FXC-only install has no bin at all). An FXC-only library
    # force-ignores the use_dxc toggle with a console warning, so the
    # request is only worth making when DXC is actually present.
    if(EXISTS "${BBLITE_DAWN_DIR}/bin/dxcompiler.dll")
        target_compile_definitions(bblite_native PRIVATE BBLITE_DAWN_DXC=1)
    else()
        target_compile_definitions(bblite_native PRIVATE BBLITE_DAWN_DXC=0)
    endif()
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

if(BBLITE_MINSIZE)
    if(MSVC)
        target_compile_options(bblite_native PRIVATE /GL /Gw /Zc:inline)
        target_link_options(
            bblite_native
            PRIVATE /LTCG /OPT:REF /OPT:ICF /INCREMENTAL:NO
        )
    else()
        target_compile_options(
            bblite_native
            PRIVATE -ffunction-sections -fdata-sections
        )
        target_link_options(bblite_native PRIVATE -Wl,--gc-sections)
    endif()
endif()

message(STATUS "Babylon Lite native features: ${BBLITE_RUNTIME_FEATURES}")
