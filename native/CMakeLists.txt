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

if(BBLITE_MINSIZE)
    set(BBLITE_VISUAL_CAPTURE_DEFAULT OFF)
else()
    set(BBLITE_VISUAL_CAPTURE_DEFAULT ON)
endif()
option(BBLITE_VISUAL_CAPTURE "Build screenshot and render-state capture" ${BBLITE_VISUAL_CAPTURE_DEFAULT})

# Image codecs reached by the scene's materialized assets: generation
# writes the list into features.cmake, and a tree without one is not a
# tree this file knows how to build.
if(NOT DEFINED BBLITE_IMAGE_CODECS)
    message(
        FATAL_ERROR
        "${BBLITE_GENERATED_DIR}/features.cmake carries no BBLITE_IMAGE_CODECS "
        "list; regenerate the scene (scene -- compile <id>)."
    )
endif()
set(BBLITE_HAS_IMAGE_DECODER OFF)
if(BBLITE_IMAGE_CODECS)
    set(BBLITE_HAS_IMAGE_DECODER ON)
endif()
set(BBLITE_REQUIRED_IMAGE_CODECS ${BBLITE_IMAGE_CODECS})
if(BBLITE_VISUAL_CAPTURE)
    list(APPEND BBLITE_REQUIRED_IMAGE_CODECS "png")
endif()
foreach(BBLITE_IMAGE_CODEC IN ITEMS "png" "jpeg" "webp")
    if(
        "${BBLITE_IMAGE_CODEC}" IN_LIST BBLITE_REQUIRED_IMAGE_CODECS
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
foreach(BBLITE_NAV_COMPONENT IN ITEMS "crowd" "tile-cache")
    if("navigation:${BBLITE_NAV_COMPONENT}" IN_LIST BBLITE_RUNTIME_FEATURES)
        list(APPEND VCPKG_MANIFEST_FEATURES "navigation-${BBLITE_NAV_COMPONENT}")
    endif()
endforeach()

# Scene-created DOM lowers to a retained UI IR. Only that reached surface
# installs the font dependency and composes RmlUi into the executable.
if(
    "ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT "ui" IN_LIST VCPKG_MANIFEST_FEATURES
)
    list(APPEND VCPKG_MANIFEST_FEATURES "ui")
endif()
if("ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES AND
   ("ui:inline-svg" IN_LIST BBLITE_RUNTIME_FEATURES OR NOT BBLITE_MINSIZE) AND
   NOT "ui-svg" IN_LIST VCPKG_MANIFEST_FEATURES)
    list(APPEND VCPKG_MANIFEST_FEATURES "ui-svg")
endif()

# A scene reaching a subsystem against a trimmed SDL that omitted it would
# fail late and opaquely. The builder records capabilities explicitly; load
# them before project() so an incompatible pair is the first configure error.
if(BBLITE_SDL_DIR)
    set(BBLITE_SDL_FEATURES "${BBLITE_SDL_DIR}/bblite-sdl-features.cmake")
    if(EXISTS "${BBLITE_SDL_FEATURES}")
        include("${BBLITE_SDL_FEATURES}")
    endif()
endif()
if(
    BBLITE_SDL_DIR
    AND "audio:engine" IN_LIST BBLITE_RUNTIME_FEATURES
)
    if(NOT BBLITE_SDL_AUDIO)
        message(
            FATAL_ERROR
            "This scene reaches audio:engine, but BBLITE_SDL_DIR does not "
            "declare BBLITE_SDL_AUDIO=ON. Use the toolchain SDL3, or build "
            "the feature-compatible trimmed install with "
            "tools/build-sdl-min.ps1 -EnableAudio."
        )
    endif()
endif()
if(
    BBLITE_SDL_DIR
    AND "input:gamepad" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT BBLITE_SDL_GAMEPAD
)
    message(
        FATAL_ERROR
        "This scene reaches input:gamepad, but BBLITE_SDL_DIR does not "
        "declare BBLITE_SDL_GAMEPAD=ON. Rebuild the trimmed install with "
        "tools/build-sdl-min.ps1 -EnableGamepad or use the toolchain SDL3."
    )
endif()
if(
    BBLITE_SDL_DIR
    AND "browser:file" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT BBLITE_SDL_DIALOG
)
    message(
        FATAL_ERROR
        "This scene reaches browser:file, but BBLITE_SDL_DIR does not "
        "declare BBLITE_SDL_DIALOG=ON. Rebuild the trimmed install with "
        "tools/build-sdl-min.ps1 or use the toolchain SDL3."
    )
endif()
# The reverse mismatch is not an error -- an over-featured SDL links and
# runs -- but a minimal build exists to ship only what the scene reaches,
# and a subsystem the trimmed SDL keeps alive through SDL_InitSubSystem
# survives dead-stripping. Name the smaller install.
if(BBLITE_SDL_DIR AND BBLITE_MINSIZE)
    foreach(bblite_sdl_subsystem IN ITEMS "AUDIO;audio:engine;-EnableAudio" "GAMEPAD;input:gamepad;-EnableGamepad")
        list(GET bblite_sdl_subsystem 0 bblite_sdl_capability)
        list(GET bblite_sdl_subsystem 1 bblite_sdl_feature)
        list(GET bblite_sdl_subsystem 2 bblite_sdl_switch)
        if(BBLITE_SDL_${bblite_sdl_capability} AND NOT "${bblite_sdl_feature}" IN_LIST BBLITE_RUNTIME_FEATURES)
            message(
                WARNING
                "This minimal scene does not reach ${bblite_sdl_feature}, but "
                "BBLITE_SDL_DIR declares BBLITE_SDL_${bblite_sdl_capability}=ON; "
                "the subsystem ships in the executable. Point BBLITE_SDL_DIR at "
                "an install built without ${bblite_sdl_switch} "
                "(tools/build-sdl-min.ps1)."
            )
        endif()
    endforeach()
endif()

if("text:layout" IN_LIST BBLITE_RUNTIME_FEATURES AND NOT "text-layout" IN_LIST VCPKG_MANIFEST_FEATURES)
    list(APPEND VCPKG_MANIFEST_FEATURES "text-layout")
endif()

# The vcpkg toolchain would copy every imported DLL beside the executable
# after each link. The build tree hard-links them instead (below, with the
# Dawn DLLs): one physical copy of ~30 MB of runtime libraries serves every
# scene tree rather than one copy per tree. The toolchain's option() runs
# during project(), so the choice is made here.
set(VCPKG_APPLOCAL_DEPS OFF)

project(babylon_lite_native LANGUAGES CXX)

set(BBLITE_GENERATED_SHADER_DIR "${BBLITE_GENERATED_DIR}/upstream/shaders")
set(BBLITE_BUILD_SHADER_DIR "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders")
file(
    GLOB_RECURSE BBLITE_GENERATED_SHADER_FILES
    CONFIGURE_DEPENDS
    LIST_DIRECTORIES false
    "${BBLITE_GENERATED_SHADER_DIR}/*"
)
list(SORT BBLITE_GENERATED_SHADER_FILES)
string(
    JOIN "\n"
    BBLITE_GENERATED_SHADER_MANIFEST_CONTENT
    ${BBLITE_GENERATED_SHADER_FILES}
)
set(
    BBLITE_GENERATED_SHADER_MANIFEST
    "${CMAKE_CURRENT_BINARY_DIR}/bblite-generated-shaders.manifest"
)
# A cached shader sidecar can be newly materialized with an mtime older than
# the existing snapshot stamp. File dependencies alone then look current even
# though the reached shader set changed. CMake rewrites file(GENERATE) output
# only when its content changes, so this sorted membership manifest invalidates
# additions/removals without making unchanged builds redeploy.
file(
    GENERATE
    OUTPUT "${BBLITE_GENERATED_SHADER_MANIFEST}"
    CONTENT "${BBLITE_GENERATED_SHADER_MANIFEST_CONTENT}\n"
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

# Offline WAV capture is a development/parity facility. It needs
# RecorderNode/libnyquist, while reached decoded audio also keeps libnyquist.
# Shipping builds leave capture out unless a caller explicitly opts back in.
if(BBLITE_MINSIZE)
    set(BBLITE_AUDIO_CAPTURE_DEFAULT OFF)
else()
    set(BBLITE_AUDIO_CAPTURE_DEFAULT ON)
endif()
option(
    BBLITE_AUDIO_CAPTURE
    "Build offline audio capture and its codec dependency"
    ${BBLITE_AUDIO_CAPTURE_DEFAULT}
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

# Installed pinned RmlUi root (tools/build-rmlui.ps1). vcpkg carries an
# rmlui port, but not at the revision pinned in upstream/rmlui.json and
# not carrying the native/patches/rmlui-*.patch files, so the library is built
# once into artifacts/tools the way Dawn, Tint and LabSound are. Unlike
# LabSound it is consumed through find_package: RmlUi's root-project
# install exports exactly the targets it built, so its package config
# resolves. Minimal builds point this at artifacts/tools/rmlui-static.
set(BBLITE_RMLUI_DEFAULT "${BBLITE_NATIVE_ROOT}/../artifacts/tools/rmlui")
if(BBLITE_MINSIZE)
    string(APPEND BBLITE_RMLUI_DEFAULT "-static")
    if("ui:inline-svg" IN_LIST BBLITE_RUNTIME_FEATURES)
        string(APPEND BBLITE_RMLUI_DEFAULT "-svg")
    endif()
endif()
set(
    BBLITE_RMLUI_DIR
    "${BBLITE_RMLUI_DEFAULT}"
    CACHE PATH
    "Installed pinned RmlUi root"
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
# One authority for the renderer translation units. `featureSources`
# (src/compiler/output-projection.ts) selects the SDL_GPU units a scene's
# reached features need into BBLITE_RUNTIME_SOURCES -- pal_sdl_gpu.cpp for
# renderer:scene, the sprite/effect/frame-graph units for theirs -- and
# every one of them has a Dawn twin under the other backend's name. The
# twins are derived from that selection here, so a unit added to (or
# renamed in) the feature table follows into both backends without a
# second list, and the Dawn scene unit follows renderer:scene exactly as
# the SDL one does. A feature decides whether a renderer exists at all;
# the backend selection decides which API draws it, and the two are
# independent -- a build with either backend removed must still compile
# every feature the scene reached.
set(BBLITE_SDL_GPU_SOURCES ${BBLITE_RUNTIME_SOURCES})
list(FILTER BBLITE_SDL_GPU_SOURCES INCLUDE REGEX "/src/pal_sdl_gpu[^/]*\\.cpp$")
set(BBLITE_DAWN_SOURCES "")
foreach(bblite_sdl_gpu_source IN LISTS BBLITE_SDL_GPU_SOURCES)
    string(REPLACE "/src/pal_sdl_gpu" "/src/pal_dawn" bblite_dawn_source "${bblite_sdl_gpu_source}")
    if(NOT EXISTS "${bblite_dawn_source}")
        message(
            FATAL_ERROR
            "${bblite_sdl_gpu_source} has no Dawn twin at ${bblite_dawn_source}; "
            "every SDL_GPU renderer unit is paired."
        )
    endif()
    list(APPEND BBLITE_DAWN_SOURCES "${bblite_dawn_source}")
endforeach()
if(NOT BBLITE_BACKEND_SDL_GPU)
    list(FILTER BBLITE_RUNTIME_SOURCES EXCLUDE REGEX "/src/pal_sdl_gpu[^/]*\\.cpp$")
endif()

# The PAL units whose preprocessed text is independent of the generated
# tree: none of them includes a header under <generated>/upstream/include
# (verified unit by unit with the preprocessor; the two backend families,
# the window realm and the build stamp do include one). They compile in
# their own object library without the generated include directory, so
# their compile lines are the same in every scene reaching the same
# features. An object library rather than an archive: the executable
# links every object exactly as before, where an archive would drop an
# unreferenced object and the static registrations it carries.
set(
    BBLITE_PAL_COMMON_PATTERN
    "/src/(pal|pal_sdl|pal_ui_rml|pal_audio_labsound|pal_physics_bullet|pal_physics_debug|pal_navigation_recast|pal_file|pal_storage|pal_text_layout)\\.cpp$"
)
set(BBLITE_PAL_COMMON_SOURCES ${BBLITE_RUNTIME_SOURCES})
list(FILTER BBLITE_PAL_COMMON_SOURCES INCLUDE REGEX "${BBLITE_PAL_COMMON_PATTERN}")
list(FILTER BBLITE_RUNTIME_SOURCES EXCLUDE REGEX "${BBLITE_PAL_COMMON_PATTERN}")

# The usage requirements every unit of the executable shares -- the
# feature macros, the include directories, the linked libraries and the
# warning and size options -- carried by one interface target both the
# object library and the executable consume.
add_library(bblite_features INTERFACE)
add_library(bblite_pal_common OBJECT ${BBLITE_PAL_COMMON_SOURCES})
target_link_libraries(bblite_pal_common PRIVATE bblite_features)
add_executable(
    bblite_native
    "${BBLITE_GENERATED_DIR}/main.cpp"
    # The one TU that includes the generated build stamp
    # (bblite_build_stamp): unconditional and scene-dependent by design,
    # so only it recompiles when the stamp changes within one tree.
    "${BBLITE_NATIVE_ROOT}/src/pal_build_stamp.cpp"
    ${BBLITE_RUNTIME_SOURCES}
    ${BBLITE_GENERATED_SOURCES}
)
target_link_libraries(bblite_native PRIVATE bblite_features bblite_pal_common)
# Only the executable's own units read the generated headers.
target_include_directories(bblite_native PRIVATE "${BBLITE_GENERATED_DIR}/upstream/include")

# One feature, one macro. Every macro named here is defined in every
# translation unit -- 1 when the generated tree reached any of the listed
# features, 0 otherwise -- so a `#if` over it never meets an undefined
# name, and the activation table below reads as the table it is.
function(bblite_feature_define macro)
    set(value 0)
    foreach(feature IN LISTS ARGN)
        if("${feature}" IN_LIST BBLITE_RUNTIME_FEATURES)
            set(value 1)
        endif()
    endforeach()
    target_compile_definitions(bblite_features INTERFACE "${macro}=${value}")
endfunction()

set(BBLITE_OFFSCREEN_SURFACES OFF)
bblite_feature_define(BBLITE_DEVICE_RECOVERY "engine:device-recovery")
bblite_feature_define(BBLITE_WORKERS "platform:workers")
if("platform:window" IN_LIST BBLITE_RUNTIME_FEATURES)
    set(BBLITE_OFFSCREEN_SURFACES ON)
    if(BBLITE_BACKEND_SDL_GPU)
        target_sources(bblite_native PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_window_presenter_sdl.cpp")
    endif()
    if(BBLITE_BACKEND_DAWN)
        target_sources(bblite_native PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_window_presenter_dawn.cpp")
    endif()
endif()
target_compile_definitions(bblite_features INTERFACE BBLITE_OFFSCREEN_SURFACES=$<BOOL:${BBLITE_OFFSCREEN_SURFACES}>)

if(MSVC)
    # Lowered value-returning lambdas keep a defensive fallthrough throw after
    # their translated control flow. LTCG can prove that some of those guards
    # are unreachable and reports C4702 late in the link; suppress that one
    # diagnostic only for generated application code, while the PAL remains
    # warning-clean under /W4 /WX.
    set_source_files_properties(
        "${BBLITE_GENERATED_DIR}/main.cpp"
        PROPERTIES COMPILE_OPTIONS "/wd4702"
    )
endif()

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
        DEPENDS
            ${BBLITE_GENERATED_SHADER_FILES}
            "${BBLITE_GENERATED_SHADER_MANIFEST}"
        VERBATIM
    )
    add_custom_target(
        bblite_shader_snapshot
        DEPENDS "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
    )
    add_dependencies(bblite_native bblite_shader_snapshot)
endif()

target_compile_features(bblite_features INTERFACE cxx_std_20)
target_include_directories(bblite_features INTERFACE "${BBLITE_NATIVE_ROOT}/include")
target_compile_definitions(bblite_features INTERFACE BBLITE_ASSET_DIR="assets")
target_compile_definitions(bblite_features INTERFACE
    BBLITE_VISUAL_CAPTURE=$<BOOL:${BBLITE_VISUAL_CAPTURE}>
    BBLITE_HAS_IMAGE_DECODER=$<BOOL:${BBLITE_HAS_IMAGE_DECODER}>
)
target_compile_definitions(bblite_features INTERFACE BBLITE_GPU_SHADER_DIR="shaders")
bblite_feature_define(BBLITE_MESH_POSITION_UPDATE "mesh:update-positions")

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
target_link_libraries(bblite_features INTERFACE SDL3::SDL3)
bblite_feature_define(BBLITE_HAS_GAMEPAD "input:gamepad")
bblite_feature_define(BBLITE_HAS_BROWSER_FILE "browser:file")

target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_SDL_GPU=$<BOOL:${BBLITE_BACKEND_SDL_GPU}>)

# Runtime libraries the executable loads beside itself, placed after each
# link (the vcpkg install's DLLs join them at the end of this file).
set(BBLITE_RUNTIME_LIBRARIES "")
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
    # The Dawn twins of the selected SDL_GPU units (derived above).
    target_sources(bblite_native PRIVATE ${BBLITE_DAWN_SOURCES})
    target_link_libraries(bblite_features INTERFACE dawn::webgpu_dawn)
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_DAWN=1)
    get_target_property(BBLITE_DAWN_LIBRARY_TYPE dawn::webgpu_dawn TYPE)
    if(BBLITE_DAWN_LIBRARY_TYPE STREQUAL "SHARED_LIBRARY")
        # Dawn resolves its DXC and validator DLLs relative to the
        # loaded module, matching how Chrome deploys them beside
        # chrome.dll.
        # FXC (d3dcompiler_47.dll) is not deployed: the PAL preloads it
        # from the executable directory or System32, so only an
        # intentionally placed SDK copy ever ships. A static Dawn
        # deploys no DLLs at all.
        list(
            APPEND BBLITE_RUNTIME_LIBRARIES
            "$<TARGET_FILE:dawn::webgpu_dawn>"
            "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxcompiler.dll"
            "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxil.dll"
        )
    endif()
    # Whether the installed Dawn carries its built DXC
    # (tools/build-dawn.ps1 deploys dxcompiler.dll and dxil.dll into
    # bin; the minimal FXC-only install has no bin at all). An FXC-only library
    # force-ignores the use_dxc toggle with a console warning, so the
    # request is only worth making when DXC is actually present.
    if(EXISTS "${BBLITE_DAWN_DIR}/bin/dxcompiler.dll" AND
       EXISTS "${BBLITE_DAWN_DIR}/bin/dxil.dll")
        target_compile_definitions(bblite_features INTERFACE BBLITE_DAWN_DXC=1)
    else()
        target_compile_definitions(bblite_features INTERFACE BBLITE_DAWN_DXC=0)
    endif()
else()
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_DAWN=0)
endif()

if(SDL3_FOUND AND BBLITE_REQUIRED_IMAGE_CODECS)
    # Use libwebp's exported config; SDL_image's fallback spells WebP_FOUND
    # differently and cannot discover static WebP consistently.
    if("webp" IN_LIST BBLITE_IMAGE_CODECS)
        find_package(WebP CONFIG REQUIRED)
    endif()
    find_package(SDL3_image CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE
        $<IF:$<TARGET_EXISTS:SDL3_image::SDL3_image-shared>,SDL3_image::SDL3_image-shared,SDL3_image::SDL3_image-static>
    )
endif()

if("text:layout" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_package(harfbuzz CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE harfbuzz::harfbuzz)
endif()

# BBLITE_RENDERER_TRANSMISSION is generated into render_capabilities.hpp,
# because a loaded asset reaches scene transmission on its own and the
# reached-feature list only records what the scene's code asked for.
bblite_feature_define(BBLITE_HAS_PBR_RENDERER "renderer:scene")

if("ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES)
    # The exact RmlUi revision projected by our backend-neutral recorder
    # is pinned in upstream/rmlui.json and installed once by
    # tools/build-rmlui.ps1, patch included, instead of being re-fetched
    # and re-built inside every UI tree at configure. The generated
    # application still links only against our UI IR entry points; this
    # dependency remains behind the PAL.
    if(NOT EXISTS "${BBLITE_RMLUI_DIR}/lib/cmake/RmlUi/RmlUiConfig.cmake")
        message(
            FATAL_ERROR
            "This scene reaches ui:rml but no RmlUi install was found at "
            "${BBLITE_RMLUI_DIR}. Build it once with tools/build-rmlui.ps1, "
            "or point BBLITE_RMLUI_DIR at an existing install."
        )
    endif()
    set(
        BBLITE_RMLUI_FEATURES
        "${BBLITE_RMLUI_DIR}/bblite-rmlui-features.cmake"
    )
    if(EXISTS "${BBLITE_RMLUI_FEATURES}")
        include("${BBLITE_RMLUI_FEATURES}")
    endif()
    # The rebuild that makes an artifact current, named by every refusal
    # below: the shipping variants take the static runtime and, for a
    # scene reaching inline SVG, the plugin.
    set(BBLITE_RMLUI_BUILD_COMMAND "tools/build-rmlui.ps1")
    if(BBLITE_MINSIZE)
        string(APPEND BBLITE_RMLUI_BUILD_COMMAND " -StaticRuntime")
        if("ui:inline-svg" IN_LIST BBLITE_RUNTIME_FEATURES)
            string(APPEND BBLITE_RMLUI_BUILD_COMMAND " -EnableSvg")
        endif()
    endif()
    if(BBLITE_MINSIZE AND NOT BBLITE_RMLUI_STATIC_RUNTIME)
        message(
            FATAL_ERROR
            "A minimal UI build requires the static-CRT RmlUi variant. "
            "Build it with ${BBLITE_RMLUI_BUILD_COMMAND} and point "
            "BBLITE_RMLUI_DIR at that install."
        )
    endif()
    # The artifact records the commit and the patch set (name=sha256, in
    # name order) it was built from; the pin and native/patches say what
    # they are now. An artifact that predates a patch would ship UI
    # behaviour the development validation never saw, so a difference is
    # a refusal naming the rebuild.
    file(READ "${BBLITE_NATIVE_ROOT}/../upstream/rmlui.json" BBLITE_RMLUI_PIN)
    string(JSON BBLITE_RMLUI_PINNED_COMMIT GET "${BBLITE_RMLUI_PIN}" commit)
    file(GLOB BBLITE_RMLUI_PATCH_FILES "${BBLITE_NATIVE_ROOT}/patches/rmlui-*.patch")
    list(SORT BBLITE_RMLUI_PATCH_FILES)
    set(BBLITE_RMLUI_EXPECTED_PATCHES "")
    foreach(bblite_rmlui_patch IN LISTS BBLITE_RMLUI_PATCH_FILES)
        get_filename_component(bblite_rmlui_patch_name "${bblite_rmlui_patch}" NAME)
        file(SHA256 "${bblite_rmlui_patch}" bblite_rmlui_patch_digest)
        list(APPEND BBLITE_RMLUI_EXPECTED_PATCHES "${bblite_rmlui_patch_name}=${bblite_rmlui_patch_digest}")
    endforeach()
    if(NOT DEFINED BBLITE_RMLUI_COMMIT OR NOT DEFINED BBLITE_RMLUI_PATCHES)
        message(
            FATAL_ERROR
            "The RmlUi install at ${BBLITE_RMLUI_DIR} records neither the "
            "commit nor the patch set it was built from. Rebuild it with "
            "${BBLITE_RMLUI_BUILD_COMMAND}."
        )
    endif()
    if(NOT BBLITE_RMLUI_COMMIT STREQUAL BBLITE_RMLUI_PINNED_COMMIT)
        message(
            FATAL_ERROR
            "The RmlUi install at ${BBLITE_RMLUI_DIR} was built from commit "
            "${BBLITE_RMLUI_COMMIT}; upstream/rmlui.json pins "
            "${BBLITE_RMLUI_PINNED_COMMIT}. Rebuild it with "
            "${BBLITE_RMLUI_BUILD_COMMAND}."
        )
    endif()
    if(NOT "${BBLITE_RMLUI_PATCHES}" STREQUAL "${BBLITE_RMLUI_EXPECTED_PATCHES}")
        message(
            FATAL_ERROR
            "The RmlUi install at ${BBLITE_RMLUI_DIR} was built with the patch "
            "set [${BBLITE_RMLUI_PATCHES}], but native/patches now holds "
            "[${BBLITE_RMLUI_EXPECTED_PATCHES}]. Rebuild it with "
            "${BBLITE_RMLUI_BUILD_COMMAND}."
        )
    endif()
    # The package config resolves Freetype::Freetype and lunasvg::lunasvg
    # itself (RmlUi's own Dependencies.cmake), against this tree's vcpkg
    # install via the ui manifest feature -- so both linked libraries follow
    # the consuming triplet and CRT.
    # find_package otherwise prefers its cached RmlUi_DIR even when PATHS and
    # NO_DEFAULT_PATH name a different install. The explicit BBLITE root must
    # choose both the backend sources and the linked library on reconfigure.
    set(
        RmlUi_DIR "${BBLITE_RMLUI_DIR}/lib/cmake/RmlUi"
        CACHE PATH "RmlUi package selected by BBLITE_RMLUI_DIR" FORCE
    )
    find_package(
        RmlUi CONFIG REQUIRED
        PATHS "${BBLITE_RMLUI_DIR}/lib/cmake/RmlUi"
        NO_DEFAULT_PATH
    )
    if(
        "ui:inline-svg" IN_LIST BBLITE_RUNTIME_FEATURES
        AND NOT RMLUI_SVG_PLUGIN
    )
        message(
            FATAL_ERROR
            "This scene reaches bounded inline SVG, but the pinned RmlUi "
            "artifact was built without its SVG plugin. Rebuild it with "
            "${BBLITE_RMLUI_BUILD_COMMAND}."
        )
    endif()
    if(BBLITE_MINSIZE AND RMLUI_SVG_PLUGIN AND
       NOT "ui:inline-svg" IN_LIST BBLITE_RUNTIME_FEATURES)
        message(FATAL_ERROR
            "This minimal scene reaches no inline SVG but its RmlUi artifact "
            "includes LunaSVG. Use tools/build-rmlui.ps1 -StaticRuntime and "
            "BBLITE_RMLUI_DIR=artifacts/tools/rmlui-static.")
    endif()

    target_sources(
        bblite_pal_common
        PRIVATE
        "${BBLITE_NATIVE_ROOT}/src/pal_system_fonts.cpp"
        # RmlUi builds Backends/ only under its samples and installs none
        # of it, so build-rmlui.ps1 carries the SDL platform pair into
        # the artifact and the translation unit compiles here, as before.
        "${BBLITE_RMLUI_DIR}/Backends/RmlUi_Platform_SDL.cpp"
    )
    target_include_directories(bblite_features INTERFACE "${BBLITE_RMLUI_DIR}/Backends"
    )
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_UI=1 RMLUI_SDL_VERSION_MAJOR=3
    )
    target_link_libraries(bblite_features INTERFACE
        RmlUi::Core
        Freetype::Freetype
    )
    if(WIN32)
        target_link_libraries(bblite_features INTERFACE dwrite)
    elseif(APPLE)
        find_library(BBLITE_CORE_FOUNDATION CoreFoundation REQUIRED)
        find_library(BBLITE_CORE_TEXT CoreText REQUIRED)
        target_link_libraries(bblite_features INTERFACE
            "${BBLITE_CORE_FOUNDATION}"
            "${BBLITE_CORE_TEXT}"
        )
    else()
        find_package(PkgConfig REQUIRED)
        pkg_check_modules(FONTCONFIG REQUIRED IMPORTED_TARGET fontconfig)
        target_link_libraries(bblite_features INTERFACE PkgConfig::FONTCONFIG)
    endif()
else()
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_UI=0)
endif()

bblite_feature_define(BBLITE_HAS_SPRITE_RENDERER "renderer:sprite")
bblite_feature_define(BBLITE_HAS_CANVAS_RENDERER "renderer:canvas")
bblite_feature_define(BBLITE_HAS_EFFECT_RENDERER "renderer:effect")
bblite_feature_define(BBLITE_HAS_FRAME_GRAPH_RENDERER "renderer:frame-graph")
bblite_feature_define(BBLITE_HAS_EFFECT_WRAPPER "effect:wrapper")
# The pin's mesh-phase Standard extension: reached only through
# enableMaterialUvTransform(), which is what emits its uniform block and the
# writer that fills it into standard_variants.hpp.
bblite_feature_define(BBLITE_HAS_STANDARD_UV_TRANSFORM "material:standard-uv-transform")
# A material plugin whose getSamplers declares a texture/sampler pair the
# composed Standard fragment reads. The record then carries the textures the
# plugin's bindTextures filled them with, and both backends upload and bind
# them through the generated standard_plugin_bindings table. That table is
# composed by the pin's own bridges, which only the opt-in registers -- so a
# scene attaching plugins without enableMaterialPlugins composes plugin-free
# and compiles none of this, exactly as it renders none of it.
if("material:plugin-textures" IN_LIST BBLITE_RUNTIME_FEATURES AND
   "material:plugins" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES=1)
else()
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_MATERIAL_PLUGIN_TEXTURES=0)
endif()
bblite_feature_define(BBLITE_HAS_EFFECT_TASK "effect:task")
bblite_feature_define(BBLITE_HAS_TEXT "text:renderable" "renderer:text")
bblite_feature_define(BBLITE_HAS_TEXT_RENDERABLE "text:renderable")
bblite_feature_define(BBLITE_HAS_TEXT_RENDERER "renderer:text")
bblite_feature_define(BBLITE_HAS_BILLBOARDS "sprite:billboard")
# A Gaussian splat cloud draws inside the scene's pass like a billboard, so
# it needs no renderer of its own -- only its pipeline and its data textures.
bblite_feature_define(BBLITE_HAS_SPLATS "loader:splat")
# A GPU pick renders the candidates into a one-pixel target and reads the id
# back, so it needs its own pipelines and attachments inside whichever
# backend is compiled -- and nothing at all in a scene that never picks.
bblite_feature_define(BBLITE_HAS_PICKING "picking:gpu")
# The detailed pick adds a third rgba32uint attachment carrying the winning
# primitive index and the interpolated rest position, its own pipeline built
# from the pin's second picking module, and a wider readback. A scene that
# never arms `enableDetailedPicking` carries none of it.
bblite_feature_define(BBLITE_HAS_DETAILED_PICKING "picking:detailed")
# The clustered light field binds a params block and three data textures into
# the composed PBR fragment's own group, from the container the scene holds.
# A scene that never adds one carries none of it.
bblite_feature_define(BBLITE_HAS_CLUSTERED_LIGHTS "light:clustered")

# The solver is reached only through `bblite/pal_physics.hpp`, whose
# implementation is one translation unit the feature list selects
# (`featureSources`). Nothing generated names Bullet. The arms of that unit
# follow the physics features the scene reached, one macro each.
if("physics:world" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_package(Bullet CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE BulletDynamics BulletCollision LinearMath
    )
endif()
bblite_feature_define(BBLITE_PHYSICS_VIEWER "physics:viewer")
bblite_feature_define(BBLITE_HAS_PHYSICS_QUERIES "physics:queries")
bblite_feature_define(BBLITE_HAS_PHYSICS_CONSTRAINTS "physics:constraints")
bblite_feature_define(BBLITE_HAS_PHYSICS_TRIGGER "physics:trigger")
bblite_feature_define(BBLITE_HAS_PHYSICS_HEIGHTFIELD "physics:heightfield")
bblite_feature_define(BBLITE_HAS_PHYSICS_CHARACTER "physics:character-controller")
bblite_feature_define(BBLITE_HAS_PHYSICS_FLOATING_ORIGIN "physics:floating-origin")

# TEMPORARY COPY (audit fix wave, native agent): the build agent owns the six
# physics sub-feature definitions below. Keep exactly one copy at merge.
# Each one is written 0/1 and named after the runtime feature it mirrors;
# `pal_physics_bullet.cpp` compiles the family behind it only when it is 1.
if("physics:queries" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_QUERIES=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_QUERIES=0)
endif()
if("physics:constraints" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_CONSTRAINTS=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_CONSTRAINTS=0)
endif()
if("physics:trigger" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_TRIGGER=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_TRIGGER=0)
endif()
if("physics:heightfield" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_HEIGHTFIELD=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_HEIGHTFIELD=0)
endif()
if("physics:character-controller" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_CHARACTER=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_CHARACTER=0)
endif()
if("physics:floating-origin" IN_LIST BBLITE_RUNTIME_FEATURES)
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_FLOATING_ORIGIN=1)
else()
    target_compile_definitions(bblite_native PRIVATE BBLITE_HAS_PHYSICS_FLOATING_ORIGIN=0)
endif()
# END TEMPORARY COPY

# The navigation toolset is reached only through
# `bblite/pal_navigation.hpp`, whose implementation is one translation
# unit the feature list selects (`featureSources`). Nothing generated
# names Recast.
if("navigation:recast" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_package(recastnavigation CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE
            RecastNavigation::Recast
            RecastNavigation::Detour
    )
    if("navigation:crowd" IN_LIST BBLITE_RUNTIME_FEATURES)
        target_link_libraries(bblite_features INTERFACE RecastNavigation::DetourCrowd)
    endif()
    # The tile-cache arm's own dependency: the two RecastDemo files the
    # overlay port builds into a library from the same pinned commit. Only
    # a scene that asked for obstacles links it, which is the same fact
    # that decided which build call was emitted.
    if("navigation:tile-cache" IN_LIST BBLITE_RUNTIME_FEATURES)
        target_link_libraries(bblite_features INTERFACE RecastNavigation::DetourTileCache RecastNavigation::RecastNavigationTileCache
        )
    endif()
    bblite_feature_define(BBLITE_HAS_NAV_CROWD "navigation:crowd")
    bblite_feature_define(BBLITE_HAS_NAV_TILE_CACHE "navigation:tile-cache")
endif()

# The Web Audio engine is reached only through `bblite/pal_audio.hpp`,
# whose implementation is one translation unit the feature list selects
# (`featureSources`). Nothing generated names LabSound. SDL3 is already
# linked as the platform layer and carries the audio device
# (`pal_audio_sdl_device.hpp`), so no second platform dependency appears.
if("audio:engine" IN_LIST BBLITE_RUNTIME_FEATURES)
    if("audio:decoded-buffer" IN_LIST BBLITE_RUNTIME_FEATURES)
        set(BBLITE_AUDIO_DECODE_FILE ON)
    else()
        set(BBLITE_AUDIO_DECODE_FILE OFF)
    endif()
    if(NOT EXISTS "${BBLITE_LABSOUND_DIR}/lib/LabSound.lib")
        message(
            FATAL_ERROR
            "This scene reaches audio:engine but no LabSound install was "
            "found at ${BBLITE_LABSOUND_DIR}. Build it once with "
            "tools/build-labsound.ps1, or point BBLITE_LABSOUND_DIR at an "
            "existing install."
        )
    endif()
    set(
        BBLITE_LABSOUND_FEATURES
        "${BBLITE_LABSOUND_DIR}/bblite-labsound-features.cmake"
    )
    if(EXISTS "${BBLITE_LABSOUND_FEATURES}")
        include("${BBLITE_LABSOUND_FEATURES}")
    endif()
    if(BBLITE_MINSIZE)
        if(NOT BBLITE_LABSOUND_STATIC_RUNTIME)
            message(
                FATAL_ERROR
                "A minimal audio build requires the static-CRT LabSound "
                "variant. Build it with tools/build-labsound.ps1 "
                "-StaticRuntime (plus -EnableCodecs for decoded audio) and "
                "point BBLITE_LABSOUND_DIR at that install."
            )
        endif()
    endif()
    if(
        NOT BBLITE_AUDIO_CAPTURE
        AND NOT BBLITE_AUDIO_DECODE_FILE
        AND NOT BBLITE_LABSOUND_CORE_ONLY
    )
        message(
            FATAL_ERROR
            "An audio build without capture/codecs requires the core-only "
            "LabSound variant. Build it with tools/build-labsound.ps1 "
            "-CoreOnly (-StaticRuntime implies it unless -EnableCodecs is set)."
        )
    endif()
    # SYSTEM: LabSound's headers are not warning-clean under /W4, and
    # this project's own sources must stay so.
    target_include_directories(bblite_features SYSTEM INTERFACE "${BBLITE_LABSOUND_DIR}/include"
    )
    target_link_libraries(bblite_features INTERFACE
            "${BBLITE_LABSOUND_DIR}/lib/LabSound.lib"
    )
    if(BBLITE_AUDIO_CAPTURE OR BBLITE_AUDIO_DECODE_FILE)
        if(NOT EXISTS "${BBLITE_LABSOUND_DIR}/lib/libnyquist.lib")
            message(
                FATAL_ERROR
                "Audio capture or decoded-file support requires libnyquist at "
                "${BBLITE_LABSOUND_DIR}/lib/libnyquist.lib."
            )
        endif()
        target_link_libraries(bblite_features INTERFACE
            "${BBLITE_LABSOUND_DIR}/lib/libnyquist.lib"
        )
    endif()
    target_compile_definitions(bblite_features INTERFACE
        BBLITE_HAS_AUDIO_CAPTURE=$<BOOL:${BBLITE_AUDIO_CAPTURE}>
        BBLITE_HAS_AUDIO_DECODE_FILE=$<BOOL:${BBLITE_AUDIO_DECODE_FILE}>
    )
    bblite_feature_define(BBLITE_HAS_AUDIO_BUFFER_SOURCE "audio:buffer-source")
    bblite_feature_define(BBLITE_HAS_AUDIO_OSCILLATOR "audio:oscillator")
    bblite_feature_define(BBLITE_HAS_AUDIO_BIQUAD_FILTER "audio:biquad-filter")
    bblite_feature_define(BBLITE_HAS_AUDIO_STEREO_PANNER "audio:stereo-panner")
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_AUDIO=1)
else()
    target_compile_definitions(bblite_features INTERFACE
        BBLITE_HAS_AUDIO=0
        BBLITE_HAS_AUDIO_CAPTURE=0
        BBLITE_HAS_AUDIO_DECODE_FILE=0
        BBLITE_HAS_AUDIO_BUFFER_SOURCE=0
        BBLITE_HAS_AUDIO_OSCILLATOR=0
        BBLITE_HAS_AUDIO_BIQUAD_FILTER=0
        BBLITE_HAS_AUDIO_STEREO_PANNER=0
    )
endif()

bblite_feature_define(BBLITE_HAS_GEOMETRY_OUTPUT "renderer:geometry-output")
bblite_feature_define(BBLITE_HAS_POST_PROCESS "renderer:post-process")
bblite_feature_define(BBLITE_HAS_SCREEN_SPACE "renderer:screen-space")

if(
    "loader:gltf" IN_LIST BBLITE_RUNTIME_FEATURES OR
    "loader:babylon" IN_LIST BBLITE_RUNTIME_FEATURES OR
    "data:json" IN_LIST BBLITE_RUNTIME_FEATURES
)
    find_package(nlohmann_json CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE nlohmann_json::nlohmann_json)
endif()

if(MSVC)
    target_compile_options(bblite_features INTERFACE /W4 /WX /permissive- /EHsc)
else()
    target_compile_options(bblite_features INTERFACE -Wall -Wextra -Wpedantic -Werror)
endif()

# The optimization level of the generated application unit alone. The
# lowered main.cpp of the largest demos is the one object that bounds a
# population rebuild (antigravity-racer's takes minutes under -O2 while
# every PAL unit is done in seconds); `O1` compiles it at -O1 and leaves
# the PAL and the generated upstream units at the configuration's level.
# `configuration` keeps the configuration's level everywhere. Measured on
# antigravity-racer and tetris with the differential parity gate before
# the default was chosen; the shipping shape keeps its own /O1 below.
set(
    BBLITE_MAIN_OPT
    "configuration"
    CACHE STRING
    "Optimization of the generated main.cpp: configuration or O1"
)
set_property(CACHE BBLITE_MAIN_OPT PROPERTY STRINGS "configuration" "O1")
if(BBLITE_MAIN_OPT STREQUAL "O1")
    if(NOT BBLITE_MINSIZE)
        if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
            set(BBLITE_MAIN_OPT_FLAGS /clang:-O1)
        elseif(MSVC)
            set(BBLITE_MAIN_OPT_FLAGS /O1)
        else()
            set(BBLITE_MAIN_OPT_FLAGS -O1)
        endif()
        set_property(
            SOURCE "${BBLITE_GENERATED_DIR}/main.cpp"
            APPEND PROPERTY COMPILE_OPTIONS ${BBLITE_MAIN_OPT_FLAGS}
        )
        # A unit compiled at another level cannot consume the tree's PCH
        # (clang refuses a precompiled file whose OptimizationLevel differs);
        # the generated unit includes what it needs itself, as the shipping
        # build without a PCH proves every time.
        set_property(
            SOURCE "${BBLITE_GENERATED_DIR}/main.cpp"
            PROPERTY SKIP_PRECOMPILE_HEADERS ON
        )
    endif()
elseif(NOT BBLITE_MAIN_OPT STREQUAL "configuration")
    message(
        FATAL_ERROR
        "BBLITE_MAIN_OPT must be configuration or O1 (got '${BBLITE_MAIN_OPT}')."
    )
endif()

if(BBLITE_MINSIZE)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        if(MSVC)
            # clang-cl needs LLVM LTO rather than MSVC's /GL. Keep the
            # Microsoft ABI and COFF section switches so the same static
            # dependencies remain link-compatible.
            target_compile_options(bblite_features INTERFACE /clang:-Oz /clang:-flto /Gy /Gw /Zc:inline
            )
            target_link_options(
                bblite_native
                PRIVATE /LTCG /OPT:REF /OPT:ICF /INCREMENTAL:NO /MAP
            )
        else()
            target_compile_options(bblite_features INTERFACE -Oz -flto -ffunction-sections
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
        target_compile_options(bblite_features INTERFACE /O1 /Ob1 /GL /Gw /Zc:inline
        )
        # /MAP emits the linker map beside the executable for
        # tools/map-size-report.mjs attribution.
        target_link_options(
            bblite_native
            PRIVATE /LTCG /OPT:REF /OPT:ICF /INCREMENTAL:NO /MAP
        )
    else()
        target_compile_options(bblite_features INTERFACE -Os -ffunction-sections -fdata-sections
        )
        target_link_options(bblite_native PRIVATE -Wl,--gc-sections)
    endif()
    if(MSVC)
        # Lowered static data can create a large initializer frame. Reserve
        # virtual address space explicitly instead of relying on Windows'
        # 1 MiB default; pages remain demand-committed. One option for both
        # Microsoft-ABI compilers, whose linker is the same.
        target_link_options(bblite_native PRIVATE /STACK:8388608)
    endif()
endif()

# Precompiled header. Every translation unit parses runtime.hpp, js_data.hpp
# and their standard-library closure before its own text; a small generated
# unit spends most of its compile there (docs/development.md carries the
# measurement). Precompiling that set once per tree removes the parse from
# every unit; the generated headers stay out, since they change with every
# generation. Off for the shipping shape: that build is the one compile of
# every unit without a precompiled closure, so an include a unit owes and
# only the PCH supplied fails there instead of in no build at all.
if(BBLITE_MINSIZE)
    set(BBLITE_PCH_DEFAULT OFF)
else()
    set(BBLITE_PCH_DEFAULT ON)
endif()
option(
    BBLITE_PCH
    "Precompile the stable native headers once per build tree"
    ${BBLITE_PCH_DEFAULT}
)
if(BBLITE_PCH)
    # The four repository headers bring the standard library they use; the
    # rest are what the PAL units include beyond them.
    set(
        BBLITE_PCH_HEADERS
        <bblite/pal.hpp>
        <bblite/pal_image.hpp>
        <bblite/runtime.hpp>
        <SDL3/SDL.h>
        <chrono>
        <cstdio>
        <cstring>
        <filesystem>
        <fstream>
        <iomanip>
        <iostream>
        <sstream>
        <stdexcept>
    )
    if(BBLITE_BACKEND_SDL_GPU)
        list(APPEND BBLITE_PCH_HEADERS <SDL3/SDL_gpu.h>)
    endif()
    if(BBLITE_BACKEND_DAWN)
        list(APPEND BBLITE_PCH_HEADERS <webgpu/webgpu.h>)
    endif()
    # The JSON runtime rides the same gate as its nlohmann include path: a
    # unit that includes it without reaching JSON must fail here as it
    # does in the static shipping tree, not compile through the PCH.
    if(
        "loader:gltf" IN_LIST BBLITE_RUNTIME_FEATURES OR
        "loader:babylon" IN_LIST BBLITE_RUNTIME_FEATURES OR
        "data:json" IN_LIST BBLITE_RUNTIME_FEATURES
    )
        list(APPEND BBLITE_PCH_HEADERS <bblite/ts_runtime.hpp>)
    endif()
    # Built once, on the object library, and reused by the executable's
    # units: both consume the same interface requirements, and the PCH
    # closure reaches no generated header.
    target_precompile_headers(bblite_pal_common PRIVATE ${BBLITE_PCH_HEADERS})
    target_precompile_headers(bblite_native REUSE_FROM bblite_pal_common)
endif()

# Runtime libraries beside the executable: the Dawn DLLs collected above
# and, for a vcpkg build, every DLL of the consumed install (the set the
# toolchain's applocal step would have copied is a subset of that
# directory; the extra links cost nothing). Hard links where the file
# system allows them, copies otherwise -- one physical file per library
# for every scene tree on the volume. A static triplet has no bin
# directory and a trimmed static SDL none either; both skip.
if(DEFINED VCPKG_INSTALLED_DIR AND DEFINED VCPKG_TARGET_TRIPLET)
    set(BBLITE_VCPKG_RUNTIME_DIRECTORY "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/bin")
else()
    set(BBLITE_VCPKG_RUNTIME_DIRECTORY "")
endif()
if(BBLITE_RUNTIME_LIBRARIES OR EXISTS "${BBLITE_VCPKG_RUNTIME_DIRECTORY}")
    add_custom_command(
        TARGET bblite_native POST_BUILD
        COMMAND
            "${CMAKE_COMMAND}"
            "-DBBLITE_FILES=${BBLITE_RUNTIME_LIBRARIES}"
            "-DBBLITE_DIRECTORY=${BBLITE_VCPKG_RUNTIME_DIRECTORY}"
            "-DBBLITE_DESTINATION=$<TARGET_FILE_DIR:bblite_native>"
            -P "${BBLITE_NATIVE_ROOT}/link-runtime-libraries.cmake"
        VERBATIM
    )
endif()

message(STATUS "Babylon Lite native features: ${BBLITE_RUNTIME_FEATURES}")
