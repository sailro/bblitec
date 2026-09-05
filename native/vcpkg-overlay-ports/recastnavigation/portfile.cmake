vcpkg_check_linkage(ONLY_STATIC_LIBRARY)

# The exact source the pinned @recast-navigation/wasm 0.43.x builds:
# isaac-mason's recastnavigation fork at the commit its build.sh checks
# out. The browser's navmesh triangulation, query and crowd behaviour
# come from these sources compiled to WASM, so the native library links
# the same commit with the compatibility and component-selection patches below.
vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO isaac-mason/recastnavigation
    REF 599fd0f023181c0a484df2a18cf1d75a3553852e
    SHA512 6e3a1ac837396eebbbd7cfb1fdd223433aaa498843278ebe8b01613c9a372f87a0b1bc7e7c9deaee63838657acf3b5c0248a90c06313f5a307d7782a59f61674
    HEAD_REF main
    PATCHES
        # The one libm call in the build pipeline. musl (the wasm's libc)
        # computes cosf through double precision; ucrt need not, and a ULP
        # between the two thresholds would flip a borderline-slope
        # triangle's walkability. Measured equal on the current corpus —
        # the patch pins the arithmetic so that stays true for any asset.
        walkable-threshold-libm.patch
        optional-components.patch
)

# The wasm reference is emscripten's strict IEEE float; MSVC's default
# /fp:precise permits FMA contraction in Recast's threshold-heavy
# span/contour pipeline. Measured equal on the current corpus — strict
# float pins the arithmetic so that stays true for any asset.
if(VCPKG_TARGET_IS_WINDOWS)
    string(APPEND VCPKG_CXX_FLAGS " /fp:strict")
    string(APPEND VCPKG_C_FLAGS " /fp:strict")
endif()

vcpkg_check_features(OUT_FEATURE_OPTIONS FEATURE_OPTIONS
    FEATURES
        crowd RECASTNAVIGATION_CROWD
        tile-cache RECASTNAVIGATION_TILE_CACHE
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        ${FEATURE_OPTIONS}
        -DRECASTNAVIGATION_DEBUG_UTILS=OFF
        -DRECASTNAVIGATION_DEMO=OFF
        -DRECASTNAVIGATION_TESTS=OFF
        -DRECASTNAVIGATION_EXAMPLES=OFF
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(CONFIG_PATH lib/cmake/recastnavigation)

vcpkg_fixup_pkgconfig()

vcpkg_copy_pdbs()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")

# The tile-cache build reaches for two files the library targets do not
# carry, both under the `RecastDemo/` tree `RECASTNAVIGATION_DEMO=OFF` does
# not build. They are compiled into a library of their own here, from THIS
# commit and under this port's own strict float, rather than handed to the
# consumer as sources -- `tile-cache/CMakeLists.txt` beside this file says
# what they are and why they live here.
if("tile-cache" IN_LIST FEATURES)
set(TILE_CACHE_SOURCE "${CURRENT_BUILDTREES_DIR}/tile-cache-src")
file(
    COPY
        "${CMAKE_CURRENT_LIST_DIR}/tile-cache/CMakeLists.txt"
        "${SOURCE_PATH}/RecastDemo/Include/ChunkyTriMesh.h"
        "${SOURCE_PATH}/RecastDemo/Source/ChunkyTriMesh.cpp"
        "${SOURCE_PATH}/RecastDemo/Contrib/fastlz/fastlz.h"
        "${SOURCE_PATH}/RecastDemo/Contrib/fastlz/fastlz.c"
    DESTINATION "${TILE_CACHE_SOURCE}"
)
file(
    COPY
        "${SOURCE_PATH}/RecastDemo/Include/ChunkyTriMesh.h"
        "${SOURCE_PATH}/RecastDemo/Contrib/fastlz/fastlz.h"
    DESTINATION "${CURRENT_PACKAGES_DIR}/include/recastnavigation"
)
vcpkg_cmake_configure(SOURCE_PATH "${TILE_CACHE_SOURCE}")
vcpkg_cmake_install()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/share")

# The package's own config brings the tile-cache target with it, so a
# consumer that found recastnavigation has already found this.
file(
    APPEND "${CURRENT_PACKAGES_DIR}/share/recastnavigation/recastnavigation-config.cmake"
    "
include(\"\${CMAKE_CURRENT_LIST_DIR}/recastnavigation-tile-cache-targets.cmake\")
"
)
endif()

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/License.txt")
