option(BBLITE_NATIVE_CACHE "Reuse compiled objects across scene trees with ccache" ON)
set(BBLITE_NATIVE_CACHE_ACTIVE OFF)
if(BBLITE_NATIVE_CACHE AND CMAKE_GENERATOR MATCHES "Ninja|Makefiles" AND NOT CMAKE_CXX_COMPILER_LAUNCHER)
    find_program(BBLITE_CCACHE NAMES ccache HINTS "${BBLITE_NATIVE_ROOT}/../artifacts/tools/ccache")
    if(BBLITE_CCACHE)
        set(BBLITE_NATIVE_CACHE_DIR "${BBLITE_NATIVE_ROOT}/../artifacts/native-cache" CACHE PATH "Shared native object cache")
        get_filename_component(BBLITE_NATIVE_CACHE_DIR "${BBLITE_NATIVE_CACHE_DIR}" ABSOLUTE)
        set(CMAKE_CXX_COMPILER_LAUNCHER "${BBLITE_CCACHE};cache_dir=${BBLITE_NATIVE_CACHE_DIR};namespace=bblite")
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
