cmake_minimum_required(VERSION 3.24)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

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
option(BBLITE_CHECKED_HANDLES "Name the call site in native record handle refusals" OFF)

include("${CMAKE_CURRENT_LIST_DIR}/dependency-features.cmake")

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
    AND NOT CMAKE_SYSTEM_NAME STREQUAL "iOS"
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

# The vcpkg toolchain would copy every imported DLL beside the executable
# after each link. The build tree hard-links them instead (below, with the
# Dawn DLLs): one physical copy of ~30 MB of runtime libraries serves every
# scene tree rather than one copy per tree. The toolchain's option() runs
# during project(), so the choice is made here.
set(VCPKG_APPLOCAL_DEPS OFF)

project(babylon_lite_native LANGUAGES CXX)
if(ANDROID)
    set(CMAKE_POSITION_INDEPENDENT_CODE ON)
    if("ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES AND ANDROID_PLATFORM_LEVEL LESS 29)
        message(FATAL_ERROR "Android system-font UI requires API 29 or newer.")
    endif()
endif()
if(IOS)
    set(BBLITE_IOS_BUNDLE_IDENTIFIER "org.bblite.prototype" CACHE STRING "iOS application identifier")
    set(BBLITE_IOS_BUNDLE_NAME "Babylon Lite" CACHE STRING "iOS application name")
    set(BBLITE_IOS_DOCUMENT_PROPERTIES "")
    if("browser:file" IN_LIST BBLITE_RUNTIME_FEATURES)
        set(BBLITE_IOS_DOCUMENT_PROPERTIES
            "<key>UIFileSharingEnabled</key><true/><key>LSSupportsOpeningDocumentsInPlace</key><true/>")
    endif()
    if(CMAKE_OSX_SYSROOT MATCHES "[Ss]imulator")
        set(BBLITE_IOS_SUPPORTED_PLATFORM "iPhoneSimulator")
        set(BBLITE_IOS_SDK "iphonesimulator")
        set(BBLITE_IOS_RUNTIME_NAME "clang_rt.iossim")
        if(NOT BBLITE_BACKEND STREQUAL "DAWN")
            message(FATAL_ERROR "iOS Simulator requires BBLITE_BACKEND=DAWN; the pinned SDL_GPU Metal backend does not support Simulator.")
        endif()
    else()
        set(BBLITE_IOS_SUPPORTED_PLATFORM "iPhoneOS")
        set(BBLITE_IOS_SDK "iphoneos")
        set(BBLITE_IOS_RUNTIME_NAME "clang_rt.ios")
    endif()
endif()
include("${BBLITE_NATIVE_ROOT}/compiler-cache.cmake")
if(BBLITE_NATIVE_CACHE_ACTIVE)
    include("${BBLITE_NATIVE_ROOT}/native-header-cache.cmake")
endif()

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
# not carrying the maintained RmlUi patches (native/patches/manifest.json),
# so the library is built once into artifacts/tools the way Dawn, Tint and
# LabSound are. Unlike LabSound it is consumed through find_package:
# RmlUi's root-project install exports exactly the targets it built, so its
# package config resolves. Minimal builds point this at
# artifacts/tools/rmlui-static.
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
# The scene renderer is its driver unit (pal_sdl_gpu.cpp) and one unit per
# feature family it draws through; the families follow the driver the
# feature table selects, and their Dawn twins follow them below.
set(BBLITE_SCENE_RENDERER_FAMILIES meshes variants shadows textures targets post_process picking)
if("${BBLITE_NATIVE_ROOT}/src/pal_sdl_gpu.cpp" IN_LIST BBLITE_RUNTIME_SOURCES)
    foreach(bblite_family IN LISTS BBLITE_SCENE_RENDERER_FAMILIES)
        list(APPEND BBLITE_RUNTIME_SOURCES "${BBLITE_NATIVE_ROOT}/src/pal_sdl_gpu_scene_${bblite_family}.cpp")
    endforeach()
endif()
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
# The bodies the GPU backends share (pal_gpu_shared.hpp's concerns) follow
# the units that include them: every renderer unit and the window realm.
if(BBLITE_SDL_GPU_SOURCES OR "platform:window" IN_LIST BBLITE_RUNTIME_FEATURES)
    list(
        APPEND BBLITE_RUNTIME_SOURCES
        "${BBLITE_NATIVE_ROOT}/src/pal_gpu_frame.cpp"
        "${BBLITE_NATIVE_ROOT}/src/pal_gpu_images.cpp"
        "${BBLITE_NATIVE_ROOT}/src/pal_gpu_shared.cpp"
    )
endif()

# The PAL units whose preprocessed text depends on the generated tree only
# through the activation macros they test (bblite/features/); the two
# backend families, the window realm, the build stamp and the navigation
# PAL include lowered module headers. Under the object cache they compile
# in their own object library against folders holding only those macros,
# so their compile lines are the same in every scene whose macros they read
# agree (a unit reaching any other generated header is refused). An object
# library rather than an archive: the executable links every object exactly
# as before, where an archive would drop an unreferenced object and the
# static registrations it carries.
set(
    BBLITE_PAL_COMMON_PATTERN
    "/src/(pal|pal_sdl|pal_image|pal_ui_rml|pal_audio_labsound|pal_physics_bullet|pal_physics_debug|pal_file|pal_storage|pal_text_layout|pal_gpu_frame|pal_gpu_images)\\.cpp$"
)
set(BBLITE_PAL_COMMON_SOURCES ${BBLITE_RUNTIME_SOURCES})
list(FILTER BBLITE_PAL_COMMON_SOURCES INCLUDE REGEX "${BBLITE_PAL_COMMON_PATTERN}")
list(FILTER BBLITE_RUNTIME_SOURCES EXCLUDE REGEX "${BBLITE_PAL_COMMON_PATTERN}")

# The usage requirements every unit of the executable shares -- the
# feature macros, the include directories, the linked libraries and the
# warning and size options -- carried by one interface target both the
# object library and the executable consume.
add_library(bblite_features INTERFACE)
if(APPLE)
    find_package(boost_charconv CONFIG REQUIRED)
    find_library(BBLITE_CORE_FOUNDATION CoreFoundation REQUIRED)
    target_link_libraries(bblite_features INTERFACE Boost::charconv "${BBLITE_CORE_FOUNDATION}")
endif()
add_library(bblite_pal_common OBJECT ${BBLITE_PAL_COMMON_SOURCES})
target_link_libraries(bblite_pal_common PRIVATE bblite_features)
# Each backend's scene renderer -- its driver and its family units, every
# one of which opens with the backend's scene header -- compiles in an object
# library of its own, so that header is parsed once per tree, in the
# library's precompiled header (the PCH block below), not once per unit.
set(BBLITE_SCENE_RENDERER_UNIT "/src/pal_(sdl_gpu|dawn)(_scene_[a-z_]+)?\\.cpp$")
set(BBLITE_SDL_GPU_SCENE_SOURCES ${BBLITE_RUNTIME_SOURCES})
list(FILTER BBLITE_SDL_GPU_SCENE_SOURCES INCLUDE REGEX "${BBLITE_SCENE_RENDERER_UNIT}")
list(FILTER BBLITE_RUNTIME_SOURCES EXCLUDE REGEX "${BBLITE_SCENE_RENDERER_UNIT}")
set(BBLITE_DAWN_SCENE_SOURCES "")
if(BBLITE_BACKEND_DAWN)
    set(BBLITE_DAWN_SCENE_SOURCES ${BBLITE_DAWN_SOURCES})
    list(FILTER BBLITE_DAWN_SCENE_SOURCES INCLUDE REGEX "${BBLITE_SCENE_RENDERER_UNIT}")
endif()
list(FILTER BBLITE_DAWN_SOURCES EXCLUDE REGEX "${BBLITE_SCENE_RENDERER_UNIT}")
set(BBLITE_SCENE_RENDERER_TARGETS "")
foreach(bblite_backend IN ITEMS sdl_gpu dawn)
    string(TOUPPER "${bblite_backend}" bblite_backend_variable)
    if(BBLITE_${bblite_backend_variable}_SCENE_SOURCES)
        add_library(bblite_${bblite_backend}_scene OBJECT ${BBLITE_${bblite_backend_variable}_SCENE_SOURCES})
        target_link_libraries(bblite_${bblite_backend}_scene PRIVATE bblite_features)
        list(APPEND BBLITE_SCENE_RENDERER_TARGETS bblite_${bblite_backend}_scene)
    endif()
endforeach()
set(BBLITE_ENTRY_SOURCE "${BBLITE_GENERATED_DIR}/main.cpp")
# The platform wrapper includes main.cpp; every other application unit is compiled normally.
set(BBLITE_APPLICATION_UNITS ${BBLITE_APPLICATION_SOURCES})
list(REMOVE_ITEM BBLITE_APPLICATION_UNITS "${BBLITE_GENERATED_DIR}/main.cpp")
# Under the object cache the lowered modules compile from content-addressed
# copies (native-header-cache.cmake), so a module two scenes generate alike
# is one cache entry.
if(BBLITE_NATIVE_CACHE_ACTIVE)
    bblite_content_addressed_sources(BBLITE_GENERATED_UNITS ${BBLITE_GENERATED_SOURCES})
else()
    set(BBLITE_GENERATED_UNITS ${BBLITE_GENERATED_SOURCES})
endif()
if(ANDROID)
    set(BBLITE_ENTRY_SOURCE "${BBLITE_NATIVE_ROOT}/src/pal_android_main.cpp")
    add_library(bblite_native SHARED "${BBLITE_ENTRY_SOURCE}")
    set_target_properties(bblite_native PROPERTIES OUTPUT_NAME main)
    set_source_files_properties("${BBLITE_ENTRY_SOURCE}" PROPERTIES
        COMPILE_DEFINITIONS "BBLITE_ANDROID_ENTRY=\"${BBLITE_GENERATED_DIR}/main.cpp\"")
    target_link_libraries(bblite_features INTERFACE log)
elseif(IOS)
    set(BBLITE_ENTRY_SOURCE "${BBLITE_NATIVE_ROOT}/src/pal_ios_main.cpp")
    add_executable(bblite_native MACOSX_BUNDLE "${BBLITE_ENTRY_SOURCE}")
    set_source_files_properties("${BBLITE_ENTRY_SOURCE}" PROPERTIES
        COMPILE_DEFINITIONS "BBLITE_IOS_ENTRY=\"${BBLITE_GENERATED_DIR}/main.cpp\"")
    set_target_properties(bblite_native PROPERTIES
        MACOSX_BUNDLE_INFO_PLIST "${BBLITE_NATIVE_ROOT}/ios/Info.plist.in"
        MACOSX_BUNDLE_GUI_IDENTIFIER "${BBLITE_IOS_BUNDLE_IDENTIFIER}"
        MACOSX_BUNDLE_BUNDLE_NAME "${BBLITE_IOS_BUNDLE_NAME}"
        XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED NO)
else()
    add_executable(bblite_native "${BBLITE_ENTRY_SOURCE}")
endif()
target_sources(
    bblite_native PRIVATE
    # The one TU that includes the generated build stamp
    # (bblite_build_stamp): unconditional and scene-dependent by design,
    # so only it recompiles when the stamp changes within one tree.
    "${BBLITE_NATIVE_ROOT}/src/pal_build_stamp.cpp"
    ${BBLITE_RUNTIME_SOURCES}
    ${BBLITE_GENERATED_UNITS}
    ${BBLITE_APPLICATION_UNITS}
)
target_link_libraries(bblite_native PRIVATE bblite_features bblite_pal_common ${BBLITE_SCENE_RENDERER_TARGETS})
# Build-option macros are defined here; every feature-keyed macro is a
# generated header of its own (bblite/features/, src/feature-macros.ts) that
# each file testing it includes, and the generator's own decisions live in
# render_capabilities.hpp. Every macro is always 0/1 and tested with a plain
# `#if X`; the undefined-macro diagnostic (the warning options below) makes a
# missing definition a compile error.
target_compile_definitions(bblite_features INTERFACE BBLITE_CHECKED_HANDLES=$<BOOL:${BBLITE_CHECKED_HANDLES}>)
if(NOT EXISTS "${BBLITE_GENERATED_DIR}/upstream/include/bblite/features")
    message(
        FATAL_ERROR
        "${BBLITE_GENERATED_DIR} carries no feature macro headers; regenerate "
        "the scene (scene -- compile <id>)."
    )
endif()

if("platform:window" IN_LIST BBLITE_RUNTIME_FEATURES)
    if(BBLITE_BACKEND_SDL_GPU)
        target_sources(bblite_native PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_window_presenter_sdl.cpp")
    endif()
    if(BBLITE_BACKEND_DAWN)
        target_sources(bblite_native PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_window_presenter_dawn.cpp")
    endif()
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
    BBLITE_AUDIO_CAPTURE=$<BOOL:${BBLITE_AUDIO_CAPTURE}>
)
target_compile_definitions(bblite_features INTERFACE BBLITE_GPU_SHADER_DIR="shaders")

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
    # The runtime reads only its compiled renderers' shader formats: SDL_GPU
    # the platform's offline binary plus the `.slots` sidecars naming each
    # pinned variant's register order, Dawn the `.native.wgsl` text it
    # compiles in-process. HLSL, reflection dumps, WGSL sources and tool
    # manifests stay in the generated tree as development artifacts.
    # The cache records the table for the deployment check
    # (`executableDeployedShaderSuffixes`, src/build-stamp.ts).
    set(BBLITE_DEPLOYED_SHADER_SUFFIXES "")
    if(BBLITE_BACKEND_SDL_GPU)
        if(WIN32)
            list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".dxil")
        elseif(APPLE)
            list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".msl")
        else()
            list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".spv")
        endif()
        list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".slots")
    endif()
    if(BBLITE_BACKEND_DAWN)
        list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".native.wgsl")
    endif()
    set(
        BBLITE_DEPLOYED_SHADER_SUFFIXES
        "${BBLITE_DEPLOYED_SHADER_SUFFIXES}"
        CACHE INTERNAL
        "Shader file suffixes the compiled renderers read"
    )
    # Deployed by a stamped target rather than POST_BUILD on the executable,
    # for the reason the asset target above records: a shader-only change
    # relinks nothing, so a POST_BUILD copy never fires and the measured run
    # reads the previous shaders beside a current executable. Driving it from
    # the snapshot stamp keeps an unchanged build a no-op without owning an
    # empty translation unit purely to force a relink.
    add_custom_command(
        OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders-deployed.stamp"
        COMMAND
            "${CMAKE_COMMAND}"
            "-DBBLITE_SOURCE=${BBLITE_BUILD_SHADER_DIR}"
            "-DBBLITE_DESTINATION=$<TARGET_FILE_DIR:bblite_native>/shaders"
            "-DBBLITE_SUFFIXES=${BBLITE_DEPLOYED_SHADER_SUFFIXES}"
            -P "${BBLITE_NATIVE_ROOT}/deploy-shaders.cmake"
        COMMAND
            "${CMAKE_COMMAND}" -E touch
            "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders-deployed.stamp"
        DEPENDS
            "${BBLITE_BUILD_SHADER_DIR}/.snapshot-stamp"
            "${BBLITE_NATIVE_ROOT}/deploy-shaders.cmake"
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
    find_package(SDL3 CONFIG QUIET NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH PATHS "${SDL3_DIR}")
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
if(IOS AND "browser:file" IN_LIST BBLITE_RUNTIME_FEATURES)
    enable_language(OBJCXX)
    set_target_properties(bblite_pal_common PROPERTIES OBJCXX_STANDARD 20 OBJCXX_STANDARD_REQUIRED YES)
    target_sources(bblite_pal_common PRIVATE "${BBLITE_NATIVE_ROOT}/src/pal_file_ios.mm")
    set_source_files_properties("${BBLITE_NATIVE_ROOT}/src/pal_file_ios.mm" PROPERTIES
        COMPILE_OPTIONS "-fobjc-arc" SKIP_PRECOMPILE_HEADERS ON)
    find_library(BBLITE_UNIFORM_TYPE_IDENTIFIERS UniformTypeIdentifiers REQUIRED)
    target_link_libraries(bblite_features INTERFACE "${BBLITE_UNIFORM_TYPE_IDENTIFIERS}")
endif()

target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_SDL_GPU=$<BOOL:${BBLITE_BACKEND_SDL_GPU}>)

# Runtime libraries the executable loads beside itself, placed after each
# link (the vcpkg install's DLLs join them at the end of this file).
set(BBLITE_RUNTIME_LIBRARIES "")
if(BBLITE_BACKEND_DAWN)
    set(
        Dawn_DIR "${BBLITE_DAWN_DIR}/lib/cmake/Dawn"
        CACHE PATH "Dawn package selected by BBLITE_DAWN_DIR" FORCE
    )
    find_package(
        Dawn CONFIG REQUIRED
        PATHS "${BBLITE_DAWN_DIR}/lib/cmake/Dawn"
        NO_DEFAULT_PATH
        NO_CMAKE_FIND_ROOT_PATH
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
    if(ANDROID AND NOT BBLITE_DAWN_LIBRARY_TYPE STREQUAL "STATIC_LIBRARY")
        message(FATAL_ERROR "Android requires a monolithic static Dawn install from tools/build-dawn.ps1 -AndroidAbi.")
    endif()
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
        )
        if(WIN32)
            list(APPEND BBLITE_RUNTIME_LIBRARIES
                "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxcompiler.dll"
                "$<TARGET_FILE_DIR:dawn::webgpu_dawn>/dxil.dll")
        elseif(APPLE)
            set_property(TARGET bblite_native APPEND PROPERTY BUILD_RPATH "@loader_path")
        elseif(UNIX)
            set_property(TARGET bblite_native APPEND PROPERTY BUILD_RPATH "$ORIGIN")
        endif()
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
    target_compile_definitions(bblite_features INTERFACE BBLITE_HAS_DAWN=0 BBLITE_DAWN_DXC=0)
endif()

if(SDL3_FOUND AND BBLITE_REQUIRED_IMAGE_CODECS)
    # Use libwebp's exported config; SDL_image's fallback spells WebP_FOUND
    # differently and cannot discover static WebP consistently.
    # The shared development SDL_image also reaches WebP when this scene
    # does not. Prefer its config there too; trimmed installs may omit it.
    find_package(WebP CONFIG QUIET)
    find_package(SDL3_image CONFIG REQUIRED)
    foreach(BBLITE_IMAGE_CODEC IN LISTS BBLITE_REQUIRED_IMAGE_CODECS)
        string(TOUPPER "${BBLITE_IMAGE_CODEC}" BBLITE_SDL_IMAGE_CODEC)
        if(BBLITE_SDL_IMAGE_CODEC STREQUAL "JPEG")
            set(BBLITE_SDL_IMAGE_CODEC "JPG")
        endif()
        if(NOT SDLIMAGE_${BBLITE_SDL_IMAGE_CODEC})
            message(FATAL_ERROR
                "The installed SDL_image lacks required codec '${BBLITE_IMAGE_CODEC}'. "
                "Prepare the scene's dependency features before using installed dependencies.")
        endif()
    endforeach()
    target_link_libraries(bblite_features INTERFACE
        $<IF:$<TARGET_EXISTS:SDL3_image::SDL3_image-shared>,SDL3_image::SDL3_image-shared,SDL3_image::SDL3_image-static>
    )
endif()

if("text:layout" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_package(harfbuzz CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE harfbuzz::harfbuzz)
endif()

if("data:locale" IN_LIST BBLITE_RUNTIME_FEATURES)
    if(WIN32)
        target_link_libraries(bblite_features INTERFACE icu)
    else()
        find_package(ICU REQUIRED COMPONENTS uc i18n)
        target_link_libraries(bblite_features INTERFACE ICU::uc ICU::i18n)
    endif()
endif()

if("platform:http" IN_LIST BBLITE_RUNTIME_FEATURES)
    if(WIN32)
        target_link_libraries(bblite_features INTERFACE winhttp)
    else()
        find_package(CURL REQUIRED)
        target_link_libraries(bblite_features INTERFACE CURL::libcurl)
    endif()
endif()

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
        if(WIN32)
            string(APPEND BBLITE_RMLUI_BUILD_COMMAND " -StaticRuntime")
        else()
            string(APPEND BBLITE_RMLUI_BUILD_COMMAND " -MinSize")
        endif()
        if("ui:inline-svg" IN_LIST BBLITE_RUNTIME_FEATURES)
            string(APPEND BBLITE_RMLUI_BUILD_COMMAND " -EnableSvg")
        endif()
    endif()
    if(BBLITE_MINSIZE AND WIN32 AND NOT BBLITE_RMLUI_STATIC_RUNTIME)
        message(
            FATAL_ERROR
            "A minimal UI build requires the static-CRT RmlUi variant. "
            "Build it with ${BBLITE_RMLUI_BUILD_COMMAND} and point "
            "BBLITE_RMLUI_DIR at that install."
        )
    endif()
    if(BBLITE_MINSIZE AND UNIX AND NOT BBLITE_RMLUI_MINSIZE)
        message(FATAL_ERROR "Minimal UI builds require RmlUi built with -MinSize: ${BBLITE_RMLUI_BUILD_COMMAND}.")
    endif()
    # The artifact's source and patch record is verified with the other
    # prebuilt dependencies (bblite_verify_dependency_artifacts, below).
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
        NO_CMAKE_FIND_ROOT_PATH
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
    target_compile_definitions(bblite_features INTERFACE RMLUI_SDL_VERSION_MAJOR=3)
    target_link_libraries(bblite_features INTERFACE
        RmlUi::Core
        Freetype::Freetype
    )
    if(WIN32)
        target_link_libraries(bblite_features INTERFACE dwrite)
    elseif(ANDROID)
        target_link_libraries(bblite_features INTERFACE android)
    elseif(APPLE)
        find_library(BBLITE_CORE_TEXT CoreText REQUIRED)
        target_link_libraries(bblite_features INTERFACE
            "${BBLITE_CORE_TEXT}"
        )
        if(IOS)
            find_library(BBLITE_CORE_GRAPHICS CoreGraphics REQUIRED)
            target_link_libraries(bblite_features INTERFACE "${BBLITE_CORE_GRAPHICS}")
        endif()
    else()
        find_package(PkgConfig REQUIRED)
        pkg_check_modules(FONTCONFIG REQUIRED IMPORTED_TARGET fontconfig)
        target_link_libraries(bblite_features INTERFACE PkgConfig::FONTCONFIG)
    endif()
endif()

# The solver is reached only through `bblite/pal_physics.hpp`, whose
# implementation is one translation unit the feature list selects
# (`featureSources`). Nothing generated names Bullet.
if("physics:world" IN_LIST BBLITE_RUNTIME_FEATURES)
    find_package(Bullet CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE BulletDynamics BulletCollision LinearMath
    )
endif()

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
    find_library(BBLITE_LABSOUND_LIBRARY NAMES LabSound
        PATHS "${BBLITE_LABSOUND_DIR}/lib" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH NO_CACHE)
    if(NOT BBLITE_LABSOUND_LIBRARY)
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
        if(WIN32 AND NOT BBLITE_LABSOUND_STATIC_RUNTIME)
            message(
                FATAL_ERROR
                "A minimal audio build requires the static-CRT LabSound "
                "variant. Build it with tools/build-labsound.ps1 "
                "-StaticRuntime (plus -EnableCodecs for decoded audio) and "
                "point BBLITE_LABSOUND_DIR at that install."
            )
        endif()
        if(UNIX AND NOT BBLITE_LABSOUND_MINSIZE)
            message(FATAL_ERROR "Minimal audio builds require tools/build-labsound.ps1 -MinSize (plus -EnableCodecs for decoded audio).")
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
            "${BBLITE_LABSOUND_LIBRARY}"
    )
    if(APPLE)
        # The pinned LabSound uses Apple's FFT and vector math implementations.
        find_library(BBLITE_ACCELERATE Accelerate REQUIRED)
        target_link_libraries(bblite_features INTERFACE "${BBLITE_ACCELERATE}")
    endif()
    if(BBLITE_AUDIO_CAPTURE OR BBLITE_AUDIO_DECODE_FILE)
        find_library(BBLITE_NYQUIST_LIBRARY NAMES libnyquist
            PATHS "${BBLITE_LABSOUND_DIR}/lib" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH NO_CACHE)
        if(NOT BBLITE_NYQUIST_LIBRARY)
            message(
                FATAL_ERROR
                "Audio capture or decoded-file support requires libnyquist at "
                "${BBLITE_LABSOUND_DIR}/lib."
            )
        endif()
        target_link_libraries(bblite_features INTERFACE
            "${BBLITE_NYQUIST_LIBRARY}"
        )
    endif()
    if(BBLITE_AUDIO_DECODE_FILE AND NOT EXISTS "${BBLITE_LABSOUND_DIR}/include/libnyquist/Decoders.h")
        message(FATAL_ERROR "Decoded audio requires the libnyquist headers; reinstall with tools/build-labsound.ps1 (-StaticRuntime -EnableCodecs for a minimal build).")
    endif()
endif()

if(
    "loader:gltf" IN_LIST BBLITE_RUNTIME_FEATURES OR
    "loader:babylon" IN_LIST BBLITE_RUNTIME_FEATURES OR
    "data:json" IN_LIST BBLITE_RUNTIME_FEATURES
)
    find_package(nlohmann_json CONFIG REQUIRED)
    target_link_libraries(bblite_features INTERFACE nlohmann_json::nlohmann_json)
endif()

if(IOS)
    # External LLVM installations often omit iOS builtins, including the
    # @available runtime used by SDL and Dawn. Use the selected Xcode's archive.
    execute_process(COMMAND xcrun --sdk "${BBLITE_IOS_SDK}" clang -print-resource-dir
        OUTPUT_VARIABLE BBLITE_IOS_CLANG_RESOURCES OUTPUT_STRIP_TRAILING_WHITESPACE
        COMMAND_ERROR_IS_FATAL ANY)
    find_library(BBLITE_IOS_RUNTIME NAMES "${BBLITE_IOS_RUNTIME_NAME}"
        PATHS "${BBLITE_IOS_CLANG_RESOURCES}/lib/darwin"
        NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH NO_CACHE REQUIRED)
    target_link_libraries(bblite_features INTERFACE "${BBLITE_IOS_RUNTIME}")
endif()

# An undefined name in a `#if` is an error in this project's units: the
# macro convention above defines every bblite macro wherever it is tested.
# Dependency headers are external -- imported and SYSTEM include directories,
# and for MSVC also the INCLUDE directories (the SDK and the standard library,
# which test undefined names themselves) -- so the check never fires there.
if(MSVC)
    target_compile_options(bblite_features INTERFACE /W4 /WX /permissive- /EHsc /bigobj)
    if(CMAKE_CXX_COMPILER_ID STREQUAL "MSVC")
        target_compile_options(bblite_features INTERFACE /we4668 /external:env:INCLUDE /external:W0)
    else()
        target_compile_options(bblite_features INTERFACE -Wundef -Werror=undef)
    endif()
else()
    target_compile_options(bblite_features INTERFACE -Wall -Wextra -Wpedantic -Werror -Wundef)
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
        elseif(APPLE)
            target_compile_options(bblite_features INTERFACE -Oz -flto)
            target_link_options(bblite_native PRIVATE -flto -Wl,-dead_strip)
        else()
            find_program(BBLITE_LLD NAMES ld.lld REQUIRED)
            target_compile_options(bblite_features INTERFACE -Oz -flto -ffunction-sections
                -fdata-sections
            )
            target_link_options(
                bblite_native PRIVATE -flto "-fuse-ld=${BBLITE_LLD}" -Wl,--gc-sections
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

# Every prebuilt dependency artifact this tree consumes must carry the source
# and patch record the pin and native/patches/manifest.json select.
include("${BBLITE_NATIVE_ROOT}/patch-identity.cmake")
bblite_verify_dependency_artifacts()

# Precompiled header. Every translation unit parses runtime.hpp, js_data.hpp
# and their standard-library closure before its own text; a small generated
# unit spends most of its compile there (docs/development.md carries the
# measurement). Precompiling that set once per tree removes the parse from
# every unit; of the generated headers only the activation macros its own
# headers test enter it. Off for the shipping shape: that build is the one
# compile of every unit without a precompiled closure, so an include a unit
# owes and only the PCH supplied fails there instead of in no build at all.
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
# Under the native cache only Clang keeps the PCH, without a timestamp in it
# and with the PCH sloppiness compiler-cache.cmake sets. clang-cl builds it
# from a source under the cache (bblite_shared_pch, below), so its bytes and
# its users' cache keys are the same in every tree of the checkout whose PCH
# inputs agree. Other compilers under the cache build without one.
set(BBLITE_SHARED_PCH OFF)
if(BBLITE_PCH AND (NOT BBLITE_NATIVE_CACHE_ACTIVE OR CMAKE_CXX_COMPILER_ID STREQUAL "Clang"))
    if(BBLITE_NATIVE_CACHE_ACTIVE)
        target_compile_options(bblite_features INTERFACE "SHELL:-Xclang -fno-pch-timestamp")
    endif()
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
    # Built once and used by every unit of the object library and the
    # executable: both consume the same interface requirements, and the PCH
    # closure reaches no generated header beyond activation macros. Each
    # backend's scene renderer library precompiles the same set and its
    # scene header, which reaches lowered module headers.
    if(BBLITE_NATIVE_CACHE_ACTIVE AND CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
        set(BBLITE_SHARED_PCH ON)
    else()
        target_precompile_headers(bblite_pal_common PRIVATE ${BBLITE_PCH_HEADERS})
        target_precompile_headers(bblite_native REUSE_FROM bblite_pal_common)
        foreach(bblite_target IN LISTS BBLITE_SCENE_RENDERER_TARGETS)
            string(REGEX REPLACE "^bblite_(.+)_scene$" "\\1" bblite_backend "${bblite_target}")
            target_precompile_headers(
                ${bblite_target} PRIVATE ${BBLITE_PCH_HEADERS}
                "${BBLITE_NATIVE_ROOT}/src/pal_${bblite_backend}_scene.hpp"
            )
        endforeach()
    endif()
endif()

# Generated headers. Without the object cache every unit reads the tree in
# place. Under it, application units, the entry and the build stamp still do;
# every repository unit and copied lowered module reads a content-addressed
# folder holding exactly the generated headers its include closure names
# (native-header-cache.cmake), so its compile line and dependencies follow
# what it reads, and a scene-invariant PAL unit's line is the same in every
# scene whose activation macros it reads agree. Each precompiled header reads
# the folder of its own closure.
if(BBLITE_NATIVE_CACHE_ACTIVE)
    set_source_files_properties(
        "${BBLITE_ENTRY_SOURCE}"
        "${BBLITE_NATIVE_ROOT}/src/pal_build_stamp.cpp"
        ${BBLITE_APPLICATION_UNITS}
        PROPERTIES INCLUDE_DIRECTORIES "${BBLITE_GENERATED_DIR}/upstream/include")
    bblite_cache_unit_headers(
        TARGETS bblite_pal_common bblite_native ${BBLITE_SCENE_RENDERER_TARGETS}
        SCENE_INVARIANT bblite_pal_common
        EXCLUDE "${BBLITE_ENTRY_SOURCE}" "${BBLITE_NATIVE_ROOT}/src/pal_build_stamp.cpp"
    )
    set(BBLITE_PCH_ROOTS "")
    foreach(bblite_pch_header IN LISTS BBLITE_PCH_HEADERS)
        if(bblite_pch_header MATCHES "^<(bblite/.+)>$")
            list(APPEND BBLITE_PCH_ROOTS "${BBLITE_NATIVE_ROOT}/include/${CMAKE_MATCH_1}")
        endif()
    endforeach()
    bblite_generated_inputs(BBLITE_PCH_GENERATED ${BBLITE_PCH_ROOTS})
    set(BBLITE_PCH_GENERATED_DIR "")
    if(BBLITE_PCH_GENERATED)
        bblite_cached_headers(BBLITE_PCH_GENERATED_DIR ${BBLITE_PCH_GENERATED})
    endif()
    if(BBLITE_SHARED_PCH)
        bblite_shared_pch(
            NAME bblite_pch
            TARGETS bblite_pal_common bblite_native
            HEADERS ${BBLITE_PCH_HEADERS}
            INCLUDE_DIRECTORY "${BBLITE_PCH_GENERATED_DIR}"
        )
    elseif(BBLITE_PCH_GENERATED_DIR)
        target_include_directories(bblite_pal_common PRIVATE "${BBLITE_PCH_GENERATED_DIR}")
    endif()
    if(BBLITE_PCH_HEADERS)
        foreach(bblite_target IN LISTS BBLITE_SCENE_RENDERER_TARGETS)
            string(REGEX REPLACE "^bblite_(.+)_scene$" "\\1" bblite_backend "${bblite_target}")
            set(bblite_scene_header "${BBLITE_NATIVE_ROOT}/src/pal_${bblite_backend}_scene.hpp")
            bblite_generated_inputs(bblite_scene_generated ${BBLITE_PCH_ROOTS} "${bblite_scene_header}")
            bblite_cached_headers(bblite_scene_generated_dir ${bblite_scene_generated})
            if(BBLITE_SHARED_PCH)
                bblite_shared_pch(
                    NAME ${bblite_target}_pch
                    TARGETS ${bblite_target}
                    HEADERS ${BBLITE_PCH_HEADERS} "${bblite_scene_header}"
                    INCLUDE_DIRECTORY "${bblite_scene_generated_dir}"
                )
            else()
                target_include_directories(${bblite_target} PRIVATE "${bblite_scene_generated_dir}")
            endif()
        endforeach()
    endif()
else()
    target_include_directories(bblite_features INTERFACE "${BBLITE_GENERATED_DIR}/upstream/include")
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
