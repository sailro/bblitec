# Generated headers per translation unit, content-addressed for the object cache.
#
# A unit names the folder it reads generated headers from on its compile line.
# A folder holding exactly the generated headers the unit's include closure
# names, keyed on their paths and bytes, is the same folder in every tree whose
# generated inputs to that unit agree: the unit's cache key and its Ninja
# dependencies then follow what it reads, and a header only other units read
# neither rebuilds nor misses it. Closures follow #include lines without
# evaluating conditions, so a unit's set can only be a superset of what the
# preprocessor opens.

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

# The generated headers, by include name, the given files' closures reach.
function(bblite_generated_inputs output)
    set(pending ${ARGN})
    set(visited "")
    set(headers "")
    while(pending)
        list(POP_FRONT pending file)
        if(file IN_LIST visited)
            continue()
        endif()
        list(APPEND visited "${file}")
        _bblite_file_includes("${file}" repository generated)
        list(APPEND pending ${repository})
        foreach(header IN LISTS generated)
            if(NOT header IN_LIST headers)
                list(APPEND headers "${header}")
                list(APPEND pending "${BBLITE_GENERATED_INCLUDE_DIR}/${header}")
            endif()
        endforeach()
    endwhile()
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

# Give every repository unit of the targets its own folder. SCENE_INVARIANT
# names targets whose units may read only the activation macros: a unit there
# that reaches any other generated header is refused, since its compile line
# would then differ between scenes that reach the same features. EXCLUDE names
# units that read the tree in place.
function(bblite_cache_unit_headers)
    cmake_parse_arguments(PARSE_ARGV 0 arg "" "" "TARGETS;SCENE_INVARIANT;EXCLUDE")
    foreach(target IN LISTS arg_TARGETS)
        get_target_property(sources ${target} SOURCES)
        foreach(source IN LISTS sources)
            get_filename_component(source "${source}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
            string(FIND "${source}" "${BBLITE_NATIVE_ROOT}/src/" native_at)
            if(NOT native_at EQUAL 0 OR source IN_LIST arg_EXCLUDE)
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
