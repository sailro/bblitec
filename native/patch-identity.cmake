# The one owner of the maintained patch series and of the record prebuilt
# dependency artifacts (Dawn, LabSound, RmlUi, the trimmed SDL) carry:
# <prefix>_SOURCE, the pinned commit or version; <prefix>_PATCHES, each
# applied patch as name=sha256 in application order; <prefix>_VARIANTS, the
# variant tokens the builder selected the series by (native/patches/manifest.json).
#
# Included by native configure (bblite_verify_dependency_artifacts refuses an
# artifact whose record differs: it would ship behaviour the development
# validation never saw) and by the overlay portfiles (bblite_patch_series).
# Run as a script by the builders and doctor:
#
#   cmake -DBBLITE_PATCH_ACTION=series|record|state -DBBLITE_PATCH_LIBRARY=<library>
#         [-DBBLITE_PATCH_VARIANTS=<a;b>] [-DBBLITE_PATCH_ARTIFACT=<directory>]
#         [-DBBLITE_PATCH_REQUIRE=<a;b>] -DBBLITE_PATCH_OUTPUT=<file> -P native/patch-identity.cmake
#
# `series` writes the patch paths to apply, one per line; `record` writes the
# record lines; `state` writes current, unrecorded or stale, then why.
#
# vcpkg keys a port by its directory, not by this file or the manifest: every
# patch in a port directory is applied under one of the port's selections
# (patches:check), so adding or removing one changes a hashed file.

set(BBLITE_PATCH_MANIFEST "${CMAKE_CURRENT_LIST_DIR}/patches/manifest.json")
get_filename_component(BBLITE_PATCH_REPOSITORY "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)

# A changed pin, manifest or patch re-runs a configure, which then refuses the
# stale artifact before anything links against it. A script has no configure.
function(_bblite_patch_depends)
    if(NOT CMAKE_SCRIPT_MODE_FILE)
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${ARGN})
    endif()
endfunction()

# The JSON array at <path...> of <json> as a CMake list (empty when absent).
function(_bblite_json_strings json out_list)
    string(JSON count ERROR_VARIABLE missing LENGTH "${json}" ${ARGN})
    set(values "")
    if(NOT missing AND count GREATER 0)
        math(EXPR last "${count} - 1")
        foreach(index RANGE ${last})
            string(JSON value GET "${json}" ${ARGN} ${index})
            list(APPEND values "${value}")
        endforeach()
    endif()
    set(${out_list} "${values}" PARENT_SCOPE)
endfunction()

# The patches of <library> a build for the variant tokens in ARGN applies, as
# absolute paths in application order: those marked `all` or carrying one of
# the tokens. A token the library does not declare is refused.
function(bblite_patch_series library out_files)
    file(READ "${BBLITE_PATCH_MANIFEST}" manifest)
    _bblite_patch_depends("${BBLITE_PATCH_MANIFEST}")
    string(JSON definition ERROR_VARIABLE missing GET "${manifest}" libraries ${library})
    if(missing)
        message(FATAL_ERROR "native/patches/manifest.json lists no library '${library}'.")
    endif()
    _bblite_json_strings("${manifest}" declared libraries ${library} variants)
    foreach(variant IN LISTS ARGN)
        if(NOT variant IN_LIST declared)
            message(
                FATAL_ERROR
                "native/patches/manifest.json defines no ${library} variant '${variant}'."
            )
        endif()
    endforeach()
    string(JSON patch_count LENGTH "${manifest}" patches)
    set(keyed "")
    if(patch_count GREATER 0)
        math(EXPR last_patch "${patch_count} - 1")
        foreach(patch_index RANGE ${last_patch})
            string(JSON patch_library GET "${manifest}" patches ${patch_index} library)
            if(NOT patch_library STREQUAL library)
                continue()
            endif()
            _bblite_json_strings("${manifest}" variants patches ${patch_index} variants)
            set(applies OFF)
            foreach(variant IN LISTS variants)
                if(variant STREQUAL "all" OR variant IN_LIST ARGN)
                    set(applies ON)
                endif()
            endforeach()
            if(NOT applies)
                continue()
            endif()
            string(JSON order GET "${manifest}" patches ${patch_index} order)
            string(JSON patch_file GET "${manifest}" patches ${patch_index} file)
            _bblite_patch_depends("${BBLITE_PATCH_REPOSITORY}/${patch_file}")
            # A fixed-width key sorts the entries by their application order.
            math(EXPR order_key "${order} + 100000")
            list(APPEND keyed "${order_key}|${BBLITE_PATCH_REPOSITORY}/${patch_file}")
        endforeach()
    endif()
    list(SORT keyed)
    set(files "")
    foreach(entry IN LISTS keyed)
        string(REGEX REPLACE "^[0-9]+\\|" "" entry "${entry}")
        list(APPEND files "${entry}")
    endforeach()
    set(${out_files} "${files}" PARENT_SCOPE)
endfunction()

# The record prefix and file name of <library>'s artifacts.
function(_bblite_patch_record_names library out_prefix out_file)
    file(READ "${BBLITE_PATCH_MANIFEST}" manifest)
    string(JSON prefix ERROR_VARIABLE missing GET "${manifest}" libraries ${library} record prefix)
    if(missing)
        message(FATAL_ERROR "native/patches/manifest.json names no record for '${library}'.")
    endif()
    string(JSON record_file GET "${manifest}" libraries ${library} record file)
    set(${out_prefix} "${prefix}" PARENT_SCOPE)
    set(${out_file} "${record_file}" PARENT_SCOPE)
endfunction()

# The record an artifact of <library> built for the variant tokens in ARGN carries.
function(bblite_expected_patch_record library out_source out_patches)
    file(READ "${BBLITE_PATCH_MANIFEST}" manifest)
    string(JSON pin_file GET "${manifest}" libraries ${library} pin file)
    string(JSON pin_field GET "${manifest}" libraries ${library} pin field)
    file(READ "${BBLITE_PATCH_REPOSITORY}/${pin_file}" pin)
    string(JSON source GET "${pin}" ${pin_field})
    _bblite_patch_depends("${BBLITE_PATCH_MANIFEST}" "${BBLITE_PATCH_REPOSITORY}/${pin_file}")
    bblite_patch_series(${library} files ${ARGN})
    set(patches "")
    foreach(patch_path IN LISTS files)
        get_filename_component(patch_name "${patch_path}" NAME)
        file(SHA256 "${patch_path}" patch_digest)
        list(APPEND patches "${patch_name}=${patch_digest}")
    endforeach()
    set(${out_source} "${source}" PARENT_SCOPE)
    set(${out_patches} "${patches}" PARENT_SCOPE)
endfunction()

# The lines a builder writes into the record of a <library> artifact built for
# the variant tokens in ARGN.
function(bblite_patch_record_lines library out_lines)
    _bblite_patch_record_names(${library} prefix record_file)
    bblite_expected_patch_record(${library} source patches ${ARGN})
    set(variants ${ARGN})
    list(SORT variants)
    set(${out_lines}
        "set(${prefix}_SOURCE \"${source}\")\nset(${prefix}_PATCHES \"${patches}\")\nset(${prefix}_VARIANTS \"${variants}\")\n"
        PARENT_SCOPE)
endfunction()

# Whether the <library> artifact at <directory> records what the pin and the
# manifest select: <out_state> is current, unrecorded or stale, <out_detail>
# says why. REQUIRE <tokens...> names the variants this consumer needs (an
# artifact built for others is stale); without it the recorded ones stand. An
# artifact recording no patch set, or (for a consumer that requires none) no
# variants, predates the record: reported, not refused, until it is rebuilt.
function(bblite_patch_record_state library directory out_state out_detail)
    cmake_parse_arguments(PARSE_ARGV 4 arg "" "" "REQUIRE")
    set(required_given OFF)
    if(DEFINED arg_REQUIRE OR "REQUIRE" IN_LIST arg_KEYWORDS_MISSING_VALUES)
        set(required_given ON)
    endif()
    set(required ${arg_REQUIRE})
    list(SORT required)
    _bblite_patch_record_names(${library} prefix record_file)
    set(record_path "${directory}/${record_file}")
    unset(${prefix}_SOURCE)
    unset(${prefix}_PATCHES)
    unset(${prefix}_VARIANTS)
    if(EXISTS "${record_path}")
        include("${record_path}")
    endif()
    if(NOT DEFINED ${prefix}_PATCHES)
        set(${out_state} "unrecorded" PARENT_SCOPE)
        set(${out_detail} "records no patch set (${record_path})" PARENT_SCOPE)
        return()
    endif()
    if(DEFINED ${prefix}_VARIANTS)
        set(variants ${${prefix}_VARIANTS})
        list(SORT variants)
        if(required_given AND NOT "${variants}" STREQUAL "${required}")
            set(${out_state} "stale" PARENT_SCOPE)
            set(${out_detail}
                "was built for the variants [${variants}], but this configuration needs [${required}]"
                PARENT_SCOPE)
            return()
        endif()
    elseif(required_given)
        set(variants ${required})
    else()
        set(${out_state} "unrecorded" PARENT_SCOPE)
        set(${out_detail} "records no variant set (${record_path})" PARENT_SCOPE)
        return()
    endif()
    bblite_expected_patch_record(${library} expected_source expected_patches ${variants})
    if(
        NOT "${${prefix}_SOURCE}" STREQUAL "${expected_source}"
        OR NOT "${${prefix}_PATCHES}" STREQUAL "${expected_patches}"
    )
        set(${out_state} "stale" PARENT_SCOPE)
        set(${out_detail}
            "was built from '${${prefix}_SOURCE}' with the patch set [${${prefix}_PATCHES}], but the pin and native/patches/manifest.json now select '${expected_source}' with [${expected_patches}]"
            PARENT_SCOPE)
        return()
    endif()
    set(${out_state} "current" PARENT_SCOPE)
    set(${out_detail} "" PARENT_SCOPE)
endfunction()

# Refuses the <library> artifact at <directory> when its record differs from
# the expected one; <rebuild> names the command that makes it current. ARGN
# as bblite_patch_record_state's.
function(bblite_verify_patch_record library directory rebuild)
    bblite_patch_record_state(${library} "${directory}" state detail ${ARGN})
    if(state STREQUAL "unrecorded")
        message(
            WARNING
            "The ${library} install at ${directory} ${detail}, so its source and "
            "patches cannot be verified. Rebuild it with ${rebuild} to record them."
        )
    elseif(state STREQUAL "stale")
        message(
            FATAL_ERROR
            "The ${library} install at ${directory} ${detail}. Rebuild it with ${rebuild}."
        )
    endif()
endfunction()

# Verifies every prebuilt artifact this configuration consumes: Dawn and the
# trimmed SDL for the variants this platform needs, LabSound and RmlUi for the
# variants they record.
function(bblite_verify_dependency_artifacts)
    if(BBLITE_BACKEND_DAWN)
        set(dawn_variants "")
        if(ANDROID)
            list(APPEND dawn_variants android)
        endif()
        if(APPLE)
            list(APPEND dawn_variants metal)
        endif()
        if(IOS)
            list(APPEND dawn_variants ios)
        endif()
        if(BBLITE_MINSIZE AND WIN32)
            set(dawn_rebuild "tools/build-dawn-min.ps1")
        else()
            set(dawn_rebuild "tools/build-dawn.ps1")
        endif()
        bblite_verify_patch_record(
            dawn "${BBLITE_DAWN_DIR}" "${dawn_rebuild}" REQUIRE ${dawn_variants}
        )
    endif()
    if(BBLITE_SDL_DIR)
        bblite_verify_patch_record(
            sdl3 "${BBLITE_SDL_DIR}" "tools/build-sdl-min.ps1" REQUIRE trimmed
        )
    endif()
    if("audio:engine" IN_LIST BBLITE_RUNTIME_FEATURES)
        bblite_verify_patch_record(labsound "${BBLITE_LABSOUND_DIR}" "tools/build-labsound.ps1")
    endif()
    if("ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES)
        bblite_verify_patch_record(
            rmlui "${BBLITE_RMLUI_DIR}" "${BBLITE_RMLUI_BUILD_COMMAND}" REQUIRE
        )
    endif()
endfunction()

if(CMAKE_SCRIPT_MODE_FILE STREQUAL CMAKE_CURRENT_LIST_FILE)
    foreach(required IN ITEMS BBLITE_PATCH_ACTION BBLITE_PATCH_LIBRARY BBLITE_PATCH_OUTPUT)
        if(NOT DEFINED ${required})
            message(FATAL_ERROR "patch-identity.cmake needs -D${required}.")
        endif()
    endforeach()
    if(BBLITE_PATCH_ACTION STREQUAL "series")
        bblite_patch_series(${BBLITE_PATCH_LIBRARY} files ${BBLITE_PATCH_VARIANTS})
        list(JOIN files "\n" text)
        file(WRITE "${BBLITE_PATCH_OUTPUT}" "${text}")
    elseif(BBLITE_PATCH_ACTION STREQUAL "record")
        bblite_patch_record_lines(${BBLITE_PATCH_LIBRARY} lines ${BBLITE_PATCH_VARIANTS})
        file(WRITE "${BBLITE_PATCH_OUTPUT}" "${lines}")
    elseif(BBLITE_PATCH_ACTION STREQUAL "state")
        if(NOT DEFINED BBLITE_PATCH_ARTIFACT)
            message(FATAL_ERROR "patch-identity.cmake state needs -DBBLITE_PATCH_ARTIFACT.")
        endif()
        if(DEFINED BBLITE_PATCH_REQUIRE)
            bblite_patch_record_state(
                ${BBLITE_PATCH_LIBRARY} "${BBLITE_PATCH_ARTIFACT}" state detail
                REQUIRE ${BBLITE_PATCH_REQUIRE}
            )
        else()
            bblite_patch_record_state(
                ${BBLITE_PATCH_LIBRARY} "${BBLITE_PATCH_ARTIFACT}" state detail
            )
        endif()
        file(WRITE "${BBLITE_PATCH_OUTPUT}" "${state}\n${detail}\n")
    else()
        message(FATAL_ERROR "Unknown BBLITE_PATCH_ACTION '${BBLITE_PATCH_ACTION}'.")
    endif()
endif()
