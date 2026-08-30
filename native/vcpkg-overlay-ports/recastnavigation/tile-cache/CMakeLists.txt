# The two RecastDemo files the tile-cache navmesh build reaches for, built
# as a library of their own.
#
# `RECASTNAVIGATION_DEMO=OFF` does not build `RecastDemo/`, but
# `generateTileCache` needs two files from it: `rcChunkyTriMesh`, the
# spatial partition each tile rasterizes through, and the FastLZ codec its
# `dtTileCacheCompressor` wraps. The portfile copies them here from the same
# pinned commit the rest of the package builds from, so the tile layers the
# native build compresses are the wasm reference's own.
#
# They are built HERE rather than handed to the consumer as sources so that
# the commit pin, the port's strict-float contract and the C toolchain
# `fastlz.c` needs all stay inside the package.

cmake_minimum_required(VERSION 3.20)
project(recastnavigation_tile_cache LANGUAGES CXX C)

add_library(RecastNavigationTileCache STATIC ChunkyTriMesh.cpp fastlz.c)

target_include_directories(
    RecastNavigationTileCache
    PUBLIC $<INSTALL_INTERFACE:include/recastnavigation>
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}
)

install(
    TARGETS RecastNavigationTileCache
    EXPORT recastnavigation-tile-cache-targets
    ARCHIVE DESTINATION lib
)
install(
    EXPORT recastnavigation-tile-cache-targets
    NAMESPACE RecastNavigation::
    FILE recastnavigation-tile-cache-targets.cmake
    DESTINATION share/recastnavigation
)
