option(BBLITE_NATIVE_CACHE "Reuse compiled objects across scene trees with ccache" ON)
set(BBLITE_NATIVE_CACHE_ACTIVE OFF)
if(BBLITE_NATIVE_CACHE AND CMAKE_GENERATOR MATCHES "Ninja|Makefiles" AND NOT CMAKE_CXX_COMPILER_LAUNCHER)
    find_program(BBLITE_CCACHE NAMES ccache HINTS "${BBLITE_NATIVE_ROOT}/../artifacts/tools/ccache")
    if(BBLITE_CCACHE)
        set(BBLITE_NATIVE_CACHE_DIR "${BBLITE_NATIVE_ROOT}/../artifacts/native-cache" CACHE PATH "Shared native object cache")
        get_filename_component(BBLITE_NATIVE_CACHE_DIR "${BBLITE_NATIVE_CACHE_DIR}" ABSOLUTE)
        # Worktrees share this cache (tools/setup-worktree.ps1). base_dir makes
        # every path under the checkout relative in the key, so another
        # checkout of the same sources hits; the size covers several trees'
        # populations instead of evicting them in turn. The sloppiness lets
        # Clang precompiled-header users be cached (native/CMakeLists.txt);
        # no native unit reads __DATE__ or __TIME__. In depend mode a miss
        # takes the unit's headers from the compiler's own dependency output
        # instead of preprocessing the unit first, a pass that re-reads every
        # header its precompiled header holds (about 0.4 s a unit); hits come
        # from direct mode either way.
        get_filename_component(BBLITE_CACHE_BASE_DIR "${BBLITE_NATIVE_ROOT}/.." ABSOLUTE)
        set(CMAKE_CXX_COMPILER_LAUNCHER
            "${BBLITE_CCACHE};cache_dir=${BBLITE_NATIVE_CACHE_DIR};namespace=bblite;base_dir=${BBLITE_CACHE_BASE_DIR};max_size=25G;depend_mode=true;sloppiness=pch_defines,time_macros,include_file_mtime,include_file_ctime")
        if(CMAKE_CXX_COMPILER_ID STREQUAL "Clang" AND CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC")
            # ccache replays /showIncludes on a hit; it does not retain the
            # dependency file requested through CMake's -clang:-MF spelling.
            set(CMAKE_DEPFILE_FLAGS_CXX "/showIncludes")
            set(CMAKE_CXX_DEPFILE_FORMAT msvc)
        endif()
        string(TOUPPER "${CMAKE_BUILD_TYPE}" BBLITE_CACHE_CONFIG)
        set(BBLITE_CACHE_FLAGS "${CMAKE_CXX_FLAGS} ${CMAKE_CXX_FLAGS_${BBLITE_CACHE_CONFIG}}")
        # Sources have absolute paths. Release objects can share a cache key
        # across output directories; debug builds retain directory checks.
        if(CMAKE_BUILD_TYPE MATCHES "^(Release|MinSizeRel)$" AND NOT BBLITE_CACHE_FLAGS MATCHES "[-/]Z[iI7]|(^| )-g")
            list(APPEND CMAKE_CXX_COMPILER_LAUNCHER "hash_dir=false")
        endif()
        set(BBLITE_NATIVE_CACHE_ACTIVE ON)
    endif()
endif()
