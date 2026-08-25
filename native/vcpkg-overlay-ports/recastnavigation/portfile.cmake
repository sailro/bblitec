vcpkg_check_linkage(ONLY_STATIC_LIBRARY)

# The exact source the pinned @recast-navigation/wasm 0.43.x builds:
# isaac-mason's recastnavigation fork at the commit its build.sh checks
# out. The browser's navmesh triangulation, query and crowd behaviour
# come from these sources compiled to WASM, so the native library links
# the same commit — unpatched, because the reference is unpatched.
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
)

# The wasm reference is emscripten's strict IEEE float; MSVC's default
# /fp:precise permits FMA contraction in Recast's threshold-heavy
# span/contour pipeline. Measured equal on the current corpus — strict
# float pins the arithmetic so that stays true for any asset.
if(VCPKG_TARGET_IS_WINDOWS)
    string(APPEND VCPKG_CXX_FLAGS " /fp:strict")
    string(APPEND VCPKG_C_FLAGS " /fp:strict")
endif()

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DRECASTNAVIGATION_DEMO=OFF
        -DRECASTNAVIGATION_TESTS=OFF
        -DRECASTNAVIGATION_EXAMPLES=OFF
)

vcpkg_cmake_install()

vcpkg_cmake_config_fixup(CONFIG_PATH lib/cmake/recastnavigation)

vcpkg_fixup_pkgconfig()

vcpkg_copy_pdbs()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")

vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/License.txt")
