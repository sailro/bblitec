# Content-addressed compile inputs for the object cache.
#
# A unit names the folder it reads generated headers from on its compile line.
# A folder holding exactly the generated headers the unit's include closure
# names, keyed on their paths and bytes, is the same folder in every tree whose
# generated inputs to that unit agree: the unit's cache key and its Ninja
# dependencies then follow what it reads, and a header only other units read
# neither rebuilds nor misses it. Closures follow #include lines without
# evaluating conditions, so a unit's set can only be a superset of what the
# preprocessor opens. Generated units compile from content-addressed copies and
# every unit of a checkout's trees uses the same precompiled header wherever its
# inputs agree, so a unit two trees generate alike is one cache entry.

set(BBLITE_GENERATED_INCLUDE_DIR "${BBLITE_GENERATED_DIR}/upstream/include")

# The files one file includes: repository files (beside it or under
# native/include) and generated headers, the latter by include name.
function(_bblite_file_includes file out_repository out_generated)
    string(MD5 key "${file}")
    get_property(scanned GLOBAL PROPERTY "BBLITE_SCANNED_${key}" SET)
    if(NOT scanned)
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${file}")
        get_filename_component(directory "${file}" DIRECTORY)
        file(STRINGS "${file}" lines REGEX "^[ \t]*#[ \t]*include[ \t]*[<\"][^>\"]+[>\"]")
        set(repository "")
        set(generated "")
        foreach(line IN LISTS lines)
            string(REGEX REPLACE "^[ \t]*#[ \t]*include[ \t]*[<\"]([^>\"]+)[>\"].*" "\\1" name "${line}")
            if(line MATCHES "^[ \t]*#[ \t]*include[ \t]*\"" AND EXISTS "${directory}/${name}")
                get_filename_component(local "${directory}/${name}" ABSOLUTE)
                string(FIND "${local}" "${BBLITE_GENERATED_INCLUDE_DIR}/" generated_at)
                if(generated_at EQUAL 0)
                    string(LENGTH "${BBLITE_GENERATED_INCLUDE_DIR}/" prefix)
                    string(SUBSTRING "${local}" ${prefix} -1 relative)
                    list(APPEND generated "${relative}")
                else()
                    list(APPEND repository "${local}")
                endif()
            elseif(EXISTS "${BBLITE_GENERATED_INCLUDE_DIR}/${name}")
                list(APPEND generated "${name}")
            elseif(EXISTS "${BBLITE_NATIVE_ROOT}/include/${name}")
                list(APPEND repository "${BBLITE_NATIVE_ROOT}/include/${name}")
            endif()
        endforeach()
        set_property(GLOBAL PROPERTY "BBLITE_SCANNED_${key}" TRUE)
        set_property(GLOBAL PROPERTY "BBLITE_REPOSITORY_${key}" "${repository}")
        set_property(GLOBAL PROPERTY "BBLITE_GENERATED_${key}" "${generated}")
    endif()
    get_property(repository GLOBAL PROPERTY "BBLITE_REPOSITORY_${key}")
    get_property(generated GLOBAL PROPERTY "BBLITE_GENERATED_${key}")
    set(${out_repository} "${repository}" PARENT_SCOPE)
    set(${out_generated} "${generated}" PARENT_SCOPE)
endfunction()

# The generated headers one file's closure reaches, memoized per file. A file
# met again while its own closure is being collected (an include cycle) adds
# nothing there and reports its depth; every file below it on that path stays
# unmemoized, since its closure lacks the cycle's head, which is complete
# once it has gathered all of them.
function(_bblite_file_closure file depth out_headers out_low)
    string(MD5 key "${file}")
    get_property(memoized GLOBAL PROPERTY "BBLITE_CLOSURE_${key}" SET)
    if(memoized)
        get_property(headers GLOBAL PROPERTY "BBLITE_CLOSURE_${key}")
        set(${out_headers} "${headers}" PARENT_SCOPE)
        set(${out_low} ${depth} PARENT_SCOPE)
        return()
    endif()
    get_property(open GLOBAL PROPERTY "BBLITE_OPEN_${key}")
    if(open)
        set(${out_headers} "" PARENT_SCOPE)
        set(${out_low} ${open} PARENT_SCOPE)
        return()
    endif()
    set_property(GLOBAL PROPERTY "BBLITE_OPEN_${key}" ${depth})
    _bblite_file_includes("${file}" repository generated)
    set(headers ${generated})
    set(low ${depth})
    set(children ${repository})
    foreach(header IN LISTS generated)
        list(APPEND children "${BBLITE_GENERATED_INCLUDE_DIR}/${header}")
    endforeach()
    math(EXPR child_depth "${depth} + 1")
    foreach(child IN LISTS children)
        _bblite_file_closure("${child}" ${child_depth} child_headers child_low)
        list(APPEND headers ${child_headers})
        if(child_low LESS low)
            set(low ${child_low})
        endif()
    endforeach()
    list(REMOVE_DUPLICATES headers)
    set_property(GLOBAL PROPERTY "BBLITE_OPEN_${key}" "")
    if(low EQUAL depth)
        set_property(GLOBAL PROPERTY "BBLITE_CLOSURE_${key}" "${headers}")
    endif()
    set(${out_headers} "${headers}" PARENT_SCOPE)
    set(${out_low} ${low} PARENT_SCOPE)
endfunction()

# The generated headers, by include name, the given files' closures reach.
function(bblite_generated_inputs output)
    set(headers "")
    foreach(file IN LISTS ARGN)
        _bblite_file_closure("${file}" 1 file_headers low)
        list(APPEND headers ${file_headers})
    endforeach()
    list(REMOVE_DUPLICATES headers)
    list(SORT headers)
    set(${output} "${headers}" PARENT_SCOPE)
endfunction()

# The content-addressed folder holding exactly these generated headers.
function(bblite_cached_headers output)
    set(headers ${ARGN})
    list(SORT headers)
    set(identity "")
    foreach(header IN LISTS headers)
        string(MD5 key "${header}")
        get_property(digest GLOBAL PROPERTY "BBLITE_DIGEST_${key}")
        if(NOT digest)
            file(SHA256 "${BBLITE_GENERATED_INCLUDE_DIR}/${header}" digest)
            set_property(GLOBAL PROPERTY "BBLITE_DIGEST_${key}" "${digest}")
        endif()
        string(APPEND identity "${header}:${digest}\n")
    endforeach()
    string(SHA256 key "${identity}")
    get_filename_component(cache_root "${BBLITE_NATIVE_CACHE_DIR}/headers" ABSOLUTE)
    set(directory "${cache_root}/${key}")
    file(MAKE_DIRECTORY "${cache_root}")
    file(LOCK "${cache_root}/${key}.lock" GUARD FUNCTION TIMEOUT 60)
    if(NOT EXISTS "${directory}/complete")
        foreach(header IN LISTS headers)
            configure_file("${BBLITE_GENERATED_INCLUDE_DIR}/${header}"
                "${directory}/${header}" COPYONLY)
        endforeach()
        file(WRITE "${directory}/complete" "${identity}")
    endif()
    set(${output} "${directory}" PARENT_SCOPE)
endfunction()

get_filename_component(BBLITE_CACHED_SOURCE_DIR "${BBLITE_NATIVE_CACHE_DIR}/sources" ABSOLUTE)

# Each generated unit as a copy named by its bytes: two trees generating the
# same unit compile the same path. A diagnostic names the copy,
# `<unit>-<digest>.cpp`, whose lines are the generated unit's.
function(bblite_content_addressed_sources output)
    set(copies "")
    file(MAKE_DIRECTORY "${BBLITE_CACHED_SOURCE_DIR}")
    foreach(source IN LISTS ARGN)
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
        file(SHA256 "${source}" digest)
        string(SUBSTRING "${digest}" 0 16 digest)
        get_filename_component(stem "${source}" NAME_WE)
        get_filename_component(extension "${source}" LAST_EXT)
        set(copy "${BBLITE_CACHED_SOURCE_DIR}/${stem}-${digest}${extension}")
        # Written under another name and renamed, so an interrupted configure
        # never leaves a partial file under the content's name.
        file(LOCK "${copy}.lock" TIMEOUT 60)
        if(NOT EXISTS "${copy}")
            configure_file("${source}" "${copy}.partial" COPYONLY)
            file(RENAME "${copy}.partial" "${copy}")
        endif()
        file(LOCK "${copy}.lock" RELEASE)
        list(APPEND copies "${copy}")
    endforeach()
    set(${output} "${copies}" PARENT_SCOPE)
endfunction()

# Give every repository and copied generated unit of the targets its own
# folder. SCENE_INVARIANT names targets whose units may read only the
# activation macros: a unit there that reaches any other generated header is
# refused, since its compile line would then differ between scenes that reach
# the same features. EXCLUDE names units that read the tree in place.
function(bblite_cache_unit_headers)
    cmake_parse_arguments(PARSE_ARGV 0 arg "" "" "TARGETS;SCENE_INVARIANT;EXCLUDE")
    foreach(target IN LISTS arg_TARGETS)
        get_target_property(sources ${target} SOURCES)
        foreach(source IN LISTS sources)
            get_filename_component(source "${source}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
            string(FIND "${source}" "${BBLITE_NATIVE_ROOT}/src/" native_at)
            string(FIND "${source}" "${BBLITE_CACHED_SOURCE_DIR}/" copy_at)
            if((NOT native_at EQUAL 0 AND NOT copy_at EQUAL 0) OR source IN_LIST arg_EXCLUDE)
                continue()
            endif()
            bblite_generated_inputs(headers "${source}")
            if(NOT headers)
                continue()
            endif()
            if(target IN_LIST arg_SCENE_INVARIANT)
                foreach(header IN LISTS headers)
                    if(NOT header MATCHES "^bblite/features/")
                        message(FATAL_ERROR
                            "${source} reaches the generated ${header}; a scene-invariant PAL "
                            "unit reads only bblite/features/ macros.")
                    endif()
                endforeach()
            endif()
            bblite_cached_headers(directory ${headers})
            set_source_files_properties("${source}" PROPERTIES INCLUDE_DIRECTORIES "${directory}")
        endforeach()
    endforeach()
endfunction()

# A precompiled header shared by build trees, for clang-cl. ccache keys a
# user's compile on the PCH's bytes, and Clang records in them the absolute
# path of every file the PCH was built from; CMake's own PCH is built from
# cmake_pch.hxx in each tree, and for MSVC-style /Yc and /Yu ccache also drops
# base_dir and keys on the tree's absolute paths, so no user of it hit across
# scenes. This PCH is built with Clang's own -emit-pch from a source named by
# its text under the cache and read through -include-pch. Its creation is
# cached without base_dir: the entry records this checkout's paths, so the
# trees of this checkout share one PCH and its users' entries, and a PCH
# naming another worktree's files is never handed out. Where ccache
# preprocesses a user, the PCH's source is included as text, so the users
# also read the folder of the PCH's generated headers. NAME is the PCH's own
# object library; HEADERS are `<system>` spellings or absolute paths.
function(bblite_shared_pch)
    cmake_parse_arguments(PARSE_ARGV 0 arg "" "NAME;INCLUDE_DIRECTORY" "TARGETS;HEADERS")
    set(text "// A precompiled header of native/CMakeLists.txt.\n")
    foreach(header IN LISTS arg_HEADERS)
        if(header MATCHES "^<")
            string(APPEND text "#include ${header}\n")
        else()
            string(APPEND text "#include \"${header}\"\n")
        endif()
    endforeach()
    string(SHA256 key "${text}")
    string(SUBSTRING "${key}" 0 16 key)
    get_filename_component(source "${BBLITE_NATIVE_CACHE_DIR}/pch/bblite_pch-${key}.cxx" ABSOLUTE)
    get_filename_component(directory "${source}" DIRECTORY)
    file(MAKE_DIRECTORY "${directory}")
    file(LOCK "${source}.lock" TIMEOUT 60)
    if(NOT EXISTS "${source}")
        file(WRITE "${source}.partial" "${text}")
        file(RENAME "${source}.partial" "${source}")
    endif()
    file(LOCK "${source}.lock" RELEASE)
    add_library(${arg_NAME} OBJECT "${source}")
    target_link_libraries(${arg_NAME} PRIVATE bblite_features)
    if(arg_INCLUDE_DIRECTORY)
        target_include_directories(${arg_NAME} PRIVATE "${arg_INCLUDE_DIRECTORY}")
    endif()
    # As clang-cl's /Yc does, the PCH instantiates the templates its headers
    # leave pending, so no user instantiates them again.
    target_compile_options(
        ${arg_NAME} PRIVATE "SHELL:-Xclang -emit-pch" "SHELL:-Xclang -fpch-instantiate-templates"
    )
    set(launcher ${CMAKE_CXX_COMPILER_LAUNCHER})
    list(FILTER launcher EXCLUDE REGEX "^base_dir=")
    set_property(TARGET ${arg_NAME} PROPERTY CXX_COMPILER_LAUNCHER "${launcher}")
    # The compile's output object is the PCH the units read. A source's
    # OBJECT_DEPENDS takes no generator expression, so the units depend on a
    # stamp touched after each compile of it.
    set(pch "$<TARGET_OBJECTS:${arg_NAME}>")
    set(stamp "${CMAKE_CURRENT_BINARY_DIR}/${arg_NAME}.stamp")
    add_custom_command(
        OUTPUT "${stamp}"
        COMMAND "${CMAKE_COMMAND}" -E touch "${stamp}"
        DEPENDS "${pch}"
        VERBATIM
    )
    add_custom_target(${arg_NAME}_stamp DEPENDS "${stamp}")
    foreach(target IN LISTS arg_TARGETS)
        add_dependencies(${target} ${arg_NAME}_stamp)
        target_compile_options(${target} PRIVATE "SHELL:-Xclang -include-pch -Xclang ${pch}")
        if(arg_INCLUDE_DIRECTORY)
            target_include_directories(${target} PRIVATE "${arg_INCLUDE_DIRECTORY}")
        endif()
        get_target_property(sources ${target} SOURCES)
        set_property(SOURCE ${sources} APPEND PROPERTY OBJECT_DEPENDS "${stamp}")
    endforeach()
endfunction()
