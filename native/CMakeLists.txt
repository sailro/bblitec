cmake_minimum_required(VERSION 3.24)

set(BBLITE_GENERATED_DIR "" CACHE PATH "Directory produced by bblitec")
if(NOT BBLITE_GENERATED_DIR)
    message(FATAL_ERROR "Set BBLITE_GENERATED_DIR to a directory containing main.cpp and features.cmake.")
endif()

get_filename_component(BBLITE_GENERATED_DIR "${BBLITE_GENERATED_DIR}" ABSOLUTE)
set(BBLITE_NATIVE_ROOT "${CMAKE_CURRENT_LIST_DIR}")
# Included before project() so the reached feature set can select
# vcpkg manifest features - the toolchain installs dependencies
# during project().
include("${BBLITE_GENERATED_DIR}/features.cmake")

# Image codecs reached by the scene's materialized assets (emitted by
# generation since codec tree-shaking). Generated directories
# predating the list carry the historical png+jpeg set.
if(NOT DEFINED BBLITE_IMAGE_CODECS)
    set(BBLITE_IMAGE_CODECS "png" "jpeg")
endif()
foreach(BBLITE_IMAGE_CODEC IN ITEMS "jpeg" "webp")
    if(
        "${BBLITE_IMAGE_CODEC}" IN_LIST BBLITE_IMAGE_CODECS
        AND NOT "${BBLITE_IMAGE_CODEC}" IN_LIST VCPKG_MANIFEST_FEATURES
    )
        list(APPEND VCPKG_MANIFEST_FEATURES "${BBLITE_IMAGE_CODEC}")
    endif()
endforeach()

# The rigid-body solver, selected the same way and for the same reason: a
# scene that creates no physics world installs and links nothing.
if(
    "physics:world" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT "physics" IN_LIST VCPKG_MANIFEST_FEATURES
)
    list(APPEND VCPKG_MANIFEST_FEATURES "physics")
endif()

# The navigation toolset, same shape: a scene that creates no navigation
# plugin installs and links nothing.
if(
    "navigation:recast" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT "navigation" IN_LIST VCPKG_MANIFEST_FEATURES
)
    list(APPEND VCPKG_MANIFEST_FEATURES "navigation")
endif()

# The trimmed SDL3 (tools/build-sdl-min.ps1) is built -DSDL_AUDIO=OFF,
# because nothing needed the subsystem until the Web Audio slice existed.
# A scene reaching audio against it would open no device and throw at the
# first frame -- a late and uninformative way to learn that a build
# option said no. Refused here, before project(), so it is the first
# thing a bad pair reports.
if(BBLITE_SDL_DIR AND "audio:engine" IN_LIST BBLITE_RUNTIME_FEATURES)
    message(
        FATAL_ERROR
        "This scene reaches audio:engine, but BBLITE_SDL_DIR selects the "
        "subsystem-trimmed SDL3, which tools/build-sdl-min.ps1 builds with "
        "SDL_AUDIO=OFF -- there is no audio device to open. Either leave "
        "BBLITE_SDL_DIR empty to use the toolchain SDL3, or rebuild the "
        "trimmed SDL with SDL_AUDIO=ON into an install root of its own and "
        "point BBLITE_SDL_DIR at that."
    )
endif()

project(babylon_lite_native LANGUAGES CXX)

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
# compiled set (target-selected offline SDL shader versus WGSL text, Dawn DLLs).
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

# Installed LabSound root (tools/build-labsound.ps1). LabSound is not in
# the vcpkg registry, so it is built once from a pinned commit into
# artifacts/tools the way Dawn and Tint are. Unlike Dawn it is consumed
# by path rather than through find_package: LabSound's install(EXPORT)
# names every backend target, including the two this build deliberately
# does not compile, so its package config cannot resolve.
set(
    BBLITE_LABSOUND_DIR
    "${BBLITE_NATIVE_ROOT}/../artifacts/tools/labsound"
    CACHE PATH
    "Installed pinned LabSound root"
)

# Optional subsystem-trimmed static SDL3 (tools/build-sdl-min.ps1).
# Empty selects the toolchain-provided SDL3 (vcpkg).
set(
    BBLITE_SDL_DIR
    ""
    CACHE PATH
    "Installed trimmed SDL3 root (empty = toolchain SDL3)"
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
    # Every SDL_GPU translation unit leaves with the backend. The feature
    # list names them because a feature decides whether a renderer exists
    # at all; the backend selection decides which API draws it, and the
    # two are independent — a build with either backend removed must still
    # compile every feature the scene reached.
    list(
        REMOVE_ITEM
        BBLITE_RUNTIME_SOURCES
        "${BBLITE_NATIVE_ROOT}/src/pal_sdl_gpu.cpp"
        "${BBLITE_NATIVE_ROOT}/src/pal_sdl_gpu_sprite.cpp"
        "${BBLITE_NATIVE_ROOT}/src/pal_sdl_gpu_effect.cpp"
    )
endif()

add_executable(
    bblite_native
    "${BBLITE_GENERATED_DIR}/main.cpp"
    # The one TU that includes the generated build stamp
    # (bblite_build_stamp): unconditional and scene-dependent by design,
    # so ONLY it recompiles when the stamp changes and every other PAL
    # object stays byte-identical across scenes.
    "${BBLITE_NATIVE_ROOT}/src/pal_build_stamp.cpp"
    ${BBLITE_RUNTIME_SOURCES}
    ${BBLITE_GENERATED_SOURCES}
)

if(BBLITE_GENERATED_SHADER_FILES)
    # The snapshot is ordered before the executable by a target dependency,
    # and reruns only when a generated shader file is newer than the stamp.
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
target_compile_definitions(bblite_native PRIVATE BBLITE_ASSET_DIR="assets")
target_compile_definitions(bblite_native PRIVATE BBLITE_GPU_SHADER_DIR="shaders")

if(EXISTS "${BBLITE_GENERATED_DIR}/assets")
    # Deployed by its own always-run target rather than POST_BUILD on the
    # executable. An asset filename is hashed from its source URL, not its
    # bytes, so re-materializing one can change its content while its name
    # and every generated source stay identical -- nothing relinks, and a
    # POST_BUILD copy never fires. The measured run then reads the previous
    # asset beside a current executable. `copy_directory_if_different`
    # keeps that honest without rewriting megabytes on every build.
    add_custom_target(
        bblite_assets
        ALL
        COMMAND
            "${CMAKE_COMMAND}" -E copy_directory_if_different
            "${BBLITE_GENERATED_DIR}/assets"
            "$<TARGET_FILE_DIR:bblite_native>/assets"
        VERBATIM
    )
    add_dependencies(bblite_assets bblite_native)
endif()

if(BBLITE_GENERATED_SHADER_FILES)
    # Deployed by a stamped target rather than POST_BUILD on the executable,
    # for the reason the asset target above records: a shader-only change
    # relinks nothing, so a POST_BUILD copy never fires and the measured run
    # reads the previous shaders beside a current executable. Driving it from
    # the snapshot stamp keeps an unchanged build a no-op without owning an
    # empty translation unit purely to force a relink.
    add_custom_command(
        OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders-deployed.stamp"
        COMMAND
            "${CMAKE_COMMAND}" -E remove_directory
            "$<TARGET_FILE_DIR:bblite_native>/shaders"
        COMMAND
            "${CMAKE_COMMAND}" -E copy_directory
            "${BBLITE_BUILD_SHADER_DIR}"
            "$<TARGET_FILE_DIR:bblite_native>/shaders"
        COMMAND
            "${CMAKE_COMMAND}" -E touch
            "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders-deployed.stamp"
        DEPENDS "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
        VERBATIM
    )
    add_custom_target(
        bblite_shader_deploy
        ALL
        DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders-deployed.stamp"
    )
    add_dependencies(bblite_shader_deploy bblite_native)
endif()

if(BBLITE_SDL_DIR)
    # find_package prefers a cached SDL3_DIR from an earlier
    # configure; pin it to the requested install so switching
    # BBLITE_SDL_DIR never silently keeps the toolchain SDL3.
    if(EXISTS "${BBLITE_SDL_DIR}/cmake/SDL3Config.cmake")
        set(SDL3_DIR "${BBLITE_SDL_DIR}/cmake" CACHE PATH "SDL3 package directory" FORCE)
    elseif(EXISTS "${BBLITE_SDL_DIR}/lib/cmake/SDL3/SDL3Config.cmake")
        set(SDL3_DIR "${BBLITE_SDL_DIR}/lib/cmake/SDL3" CACHE PATH "SDL3 package directory" FORCE)
    else()
        message(
            FATAL_ERROR
            "BBLITE_SDL_DIR does not contain an SDL3 CMake package: ${BBLITE_SDL_DIR}"
        )
    endif()
    # Not REQUIRED: the shared guard below is the one refusal, and its
    # message names both ways to fix a missing SDL3.
    find_package(SDL3 CONFIG QUIET NO_DEFAULT_PATH PATHS "${SDL3_DIR}")
    # Trimmed installs carry a single configuration (MinSizeRel); map
    # every consumer configuration onto whichever exists.
    foreach(bblite_sdl_target SDL3::SDL3-static SDL3::SDL3-shared)
        if(TARGET ${bblite_sdl_target})
            set_target_properties(
                ${bblite_sdl_target}
                PROPERTIES
                MAP_IMPORTED_CONFIG_RELEASE "Release;MinSizeRel;RelWithDebInfo"
                MAP_IMPORTED_CONFIG_RELWITHDEBINFO "RelWithDebInfo;Release;MinSizeRel"
                MAP_IMPORTED_CONFIG_MINSIZEREL "MinSizeRel;Release;RelWithDebInfo"
                MAP_IMPORTED_CONFIG_DEBUG "Debug;Release;MinSizeRel;RelWithDebInfo"
            )
        endif()
    endforeach()
else()
    # Forget a trimmed-SDL selection from an earlier configure of this
    # build directory; the toolchain package should win again.
    unset(SDL3_DIR CACHE)
    find_package(SDL3 CONFIG QUIET)
endif()
# SDL3 is required, not optional: it is the platform layer both GPU
# backends bring their window, events and device up through, and bblitec
# has no path that renders without one.
if(NOT SDL3_FOUND)
    message(
        FATAL_ERROR
        "SDL3 was not found. It is required: bblitec renders only on a GPU, "
        "and both backends reach the device through SDL3. Set VCPKG_ROOT (or "
        "BBLITE_SDL_DIR) and configure this build directory again."
    )
endif()
target_link_libraries(bblite_native PRIVATE SDL3::SDL3)

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
    if("renderer:sprite" IN_LIST BBLITE_RUNTIME_FEATURES)
        target_sources(
            bblite_native
            PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_dawn_sprite.cpp"
        )
    endif()
    if("renderer:effect" IN_LIST BBLITE_RUNTIME_FEATURES)
        target_sources(
            bblite_native
            PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_dawn_effect.cpp"
        )
    endif()
    target_link_libraries(bblite_native PRIVATE dawn::webgpu_dawn)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_DAWN=1)
    get_target_property(BBLITE_DAWN_LIBRARY_TYPE dawn::webgpu_dawn TYPE)
    if(BBLITE_DAWN_LIBRARY_TYPE STREQUAL "SHARED_LIBRARY")
        # Dawn resolves its DXC and validator DLLs relative to the
        # loaded module, matching how Chrome deploys them beside
        # chrome.dll.
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
    # (tools/build-dawn.ps1 deploys dxcompiler.dll and dxil.dll into
    # bin; the minimal FXC-only install has no bin at all). An FXC-only library
    # force-ignores the use_dxc toggle with a console warning, so the
    # request is only worth making when DXC is actually present.
    if(EXISTS "${BBLITE_DAWN_DIR}/bin/dxcompiler.dll" AND
       EXISTS "${BBLITE_DAWN_DIR}/bin/dxil.dll")
        target_compile_definitions(bblite_native PRIVATE BBLITE_DAWN_DXC=1)
    else()
        target_compile_definitions(bblite_native PRIVATE BBLITE_DAWN_DXC=0)
    endif()
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_DAWN=0)
endif()

if("renderer:pbr" IN_LIST BBLITE_RUNTIME_FEATURES)
    # BBLITE_RENDERER_TRANSMISSION is generated into render_capabilities.hpp,
    # because a loaded asset reaches scene transmission on its own and the
    # reached-feature list only records what the scene's code asked for.
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

if("renderer:sprite" IN_LIST BBLITE_RUNTIME_FEATURES)
    # The sprite atlas is a PNG decoded at load, so this path needs the
    # image decoder even when no PBR renderer is compiled.
    if(SDL3_FOUND)
        find_package(SDL3_image CONFIG REQUIRED)
        target_link_libraries(
            bblite_native
            PRIVATE
            $<IF:$<TARGET_EXISTS:SDL3_image::SDL3_image-shared>,SDL3_image::SDL3_image-shared,SDL3_image::SDL3_image-static>
        )
    endif()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_SPRITE_RENDERER=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_SPRITE_RENDERER=0
    )
endif()

if("renderer:effect" IN_LIST BBLITE_RUNTIME_FEATURES)
    # A scene-less effect renderer still saves its screenshot as a PNG, so
    # this path needs the image encoder even when no PBR renderer or sprite
    # atlas is compiled.
    if(SDL3_FOUND)
        find_package(SDL3_image CONFIG REQUIRED)
        target_link_libraries(
            bblite_native
            PRIVATE
            $<IF:$<TARGET_EXISTS:SDL3_image::SDL3_image-shared>,SDL3_image::SDL3_image-shared,SDL3_image::SDL3_image-static>
        )
    endif()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_EFFECT_RENDERER=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_EFFECT_RENDERER=0
    )
endif()

if("effect:wrapper" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_EFFECT_WRAPPER=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_EFFECT_WRAPPER=0
    )
endif()

# The pin's mesh-phase Standard extension: reached only through
# enableMaterialUvTransform(), which is what emits its uniform block and the
# writer that fills it into standard_variants.hpp.
if("material:standard-uv-transform" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_STANDARD_UV_TRANSFORM=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_STANDARD_UV_TRANSFORM=0
    )
endif()

if("effect:task" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_EFFECT_TASK=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_EFFECT_TASK=0
    )
endif()

if("sprite:billboard" IN_LIST BBLITE_RUNTIME_FEATURES)
    # A billboard draws inside the scene's pass, so unlike a 2D sprite layer
    # it needs no renderer of its own -- but it still decodes the atlas PNG.
    if(SDL3_FOUND)
        find_package(SDL3_image CONFIG REQUIRED)
        target_link_libraries(
            bblite_native
            PRIVATE
            $<IF:$<TARGET_EXISTS:SDL3_image::SDL3_image-shared>,SDL3_image::SDL3_image-shared,SDL3_image::SDL3_image-static>
        )
    endif()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_BILLBOARDS=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_BILLBOARDS=0
    )
endif()

# A Gaussian splat cloud draws inside the scene's pass like a billboard, so
# it needs no renderer of its own -- only its pipeline and its data textures.
if("loader:splat" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_SPLATS=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_SPLATS=0
    )
endif()

# The solver is reached only through `bblite/pal_physics.hpp`, whose
# implementation is one translation unit the feature list selects
# (`featureSources`). Nothing generated names Bullet.
if("physics:world" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_package(Bullet CONFIG REQUIRED)
    target_link_libraries(
        bblite_native
        PRIVATE BulletDynamics BulletCollision LinearMath
    )
endif()

# The navigation toolset is reached only through
# `bblite/pal_navigation.hpp`, whose implementation is one translation
# unit the feature list selects (`featureSources`). Nothing generated
# names Recast.
if("navigation:recast" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_package(recastnavigation CONFIG REQUIRED)
    target_link_libraries(
        bblite_native
        PRIVATE
            RecastNavigation::Recast
            RecastNavigation::Detour
            RecastNavigation::DetourCrowd
            RecastNavigation::DetourTileCache
            RecastNavigation::DebugUtils
    )
endif()

# The Web Audio engine is reached only through `bblite/pal_audio.hpp`,
# whose implementation is one translation unit the feature list selects
# (`featureSources`). Nothing generated names LabSound. SDL3 is already
# linked as the platform layer and carries the audio device
# (`pal_audio_sdl_device.hpp`), so no second platform dependency appears.
if("audio:engine" IN_LIST BBLITE_RUNTIME_FEATURES)
    if(NOT EXISTS "${BBLITE_LABSOUND_DIR}/lib/LabSound.lib")
        message(
            FATAL_ERROR
            "This scene reaches audio:engine but no LabSound install was "
            "found at ${BBLITE_LABSOUND_DIR}. Build it once with "
            "tools/build-labsound.ps1, or point BBLITE_LABSOUND_DIR at an "
            "existing install."
        )
    endif()
    # SYSTEM: LabSound's headers are not warning-clean under /W4, and
    # this project's own sources must stay so.
    target_include_directories(
        bblite_native
        SYSTEM PRIVATE "${BBLITE_LABSOUND_DIR}/include"
    )
    target_link_libraries(
        bblite_native
        PRIVATE
            "${BBLITE_LABSOUND_DIR}/lib/LabSound.lib"
            "${BBLITE_LABSOUND_DIR}/lib/libnyquist.lib"
    )
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_AUDIO=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_AUDIO=0)
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

if("renderer:post-process" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_POST_PROCESS=1
    )
else()
    target_compile_definitions(
        bblite_native
        PRIVATE BBLITE_HAS_POST_PROCESS=0
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
    target_compile_options(bblite_native PRIVATE /W4 /WX /permissive- /EHsc)
else()
    target_compile_options(bblite_native PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()

if(BBLITE_MINSIZE)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        if(MSVC)
            # clang-cl needs LLVM LTO rather than MSVC's /GL. Keep the
            # Microsoft ABI and COFF section switches so the same static
            # dependencies remain link-compatible.
            target_compile_options(
                bblite_native
                PRIVATE /clang:-Oz /clang:-flto /Gy /Gw /Zc:inline
            )
            target_link_options(
                bblite_native
                PRIVATE /LTCG /OPT:REF /OPT:ICF /INCREMENTAL:NO /MAP
            )
        else()
            target_compile_options(
                bblite_native PRIVATE -Oz -flto -ffunction-sections
                -fdata-sections
            )
            target_link_options(
                bblite_native PRIVATE -flto -Wl,--gc-sections
            )
        endif()
    elseif(MSVC)
        # The scene command configures Release even for this opt-in shape.
        # Override Release's /O2 /Ob2 for the application just as the trimmed
        # dependency builds do; the later options win in MSVC's command line.
        target_compile_options(
            bblite_native PRIVATE /O1 /Ob1 /GL /Gw /Zc:inline
        )
        # /MAP emits the linker map beside the executable for
        # tools/map-size-report.mjs attribution.
        target_link_options(
            bblite_native
            PRIVATE /LTCG /OPT:REF /OPT:ICF /INCREMENTAL:NO /MAP
        )
    else()
        target_compile_options(
            bblite_native
            PRIVATE -Os -ffunction-sections -fdata-sections
        )
        target_link_options(bblite_native PRIVATE -Wl,--gc-sections)
    endif()
endif()

message(STATUS "Babylon Lite native features: ${BBLITE_RUNTIME_FEATURES}")
