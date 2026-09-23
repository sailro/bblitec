# Prebuilt dependency artifacts (Dawn, LabSound, RmlUi, the trimmed SDL) record
# what they were built from: <prefix>_SOURCE, the pinned commit or version, and
# <prefix>_PATCHES, each applied patch as name=sha256 in application order
# (Get-PatchRecord in tools/bblite-tools.psm1). The functions below recompute
# the expected record from the pin and native/patches/manifest.json and refuse
# an artifact whose record differs: it would ship behaviour the development
# validation never saw. src/development-tools.ts applies the same comparison.
# An artifact that records no patch set predates the record and is reported,
# not refused, until it is rebuilt.

set(BBLITE_PATCH_MANIFEST "${CMAKE_CURRENT_LIST_DIR}/manifest.json")
get_filename_component(BBLITE_PATCH_REPOSITORY "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)

# The record a <library> artifact built for the given variant tokens must carry.
function(bblite_expected_patch_record library out_source out_patches)
    file(READ "${BBLITE_PATCH_MANIFEST}" manifest)
    string(JSON pin_file GET "${manifest}" libraries ${library} pin file)
    string(JSON pin_field GET "${manifest}" libraries ${library} pin field)
    file(READ "${BBLITE_PATCH_REPOSITORY}/${pin_file}" pin)
    string(JSON source GET "${pin}" ${pin_field})
    # A changed pin, manifest or patch re-runs the configure, which refuses
    # the then stale artifact before anything links against it.
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
        "${BBLITE_PATCH_MANIFEST}" "${BBLITE_PATCH_REPOSITORY}/${pin_file}")
    string(JSON patch_count LENGTH "${manifest}" patches)
    set(keyed "")
    math(EXPR last_patch "${patch_count} - 1")
    foreach(patch_index RANGE ${last_patch})
        string(JSON patch_library GET "${manifest}" patches ${patch_index} library)
        if(NOT patch_library STREQUAL library)
            continue()
        endif()
        set(applies OFF)
        string(JSON variant_count LENGTH "${manifest}" patches ${patch_index} variants)
        if(variant_count GREATER 0)
            math(EXPR last_variant "${variant_count} - 1")
            foreach(variant_index RANGE ${last_variant})
                string(JSON variant GET "${manifest}" patches ${patch_index} variants ${variant_index})
                if(variant STREQUAL "all" OR variant IN_LIST ARGN)
                    set(applies ON)
                endif()
            endforeach()
        endif()
        if(NOT applies)
            continue()
        endif()
        string(JSON order GET "${manifest}" patches ${patch_index} order)
        string(JSON patch_file GET "${manifest}" patches ${patch_index} file)
        get_filename_component(patch_name "${patch_file}" NAME)
        file(SHA256 "${BBLITE_PATCH_REPOSITORY}/${patch_file}" patch_digest)
        set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
            "${BBLITE_PATCH_REPOSITORY}/${patch_file}")
        # A fixed-width key sorts the entries by their application order.
        math(EXPR order_key "${order} + 100000")
        list(APPEND keyed "${order_key}|${patch_name}=${patch_digest}")
    endforeach()
    list(SORT keyed)
    set(patches "")
    foreach(entry IN LISTS keyed)
        string(REGEX REPLACE "^[0-9]+\\|" "" entry "${entry}")
        list(APPEND patches "${entry}")
    endforeach()
    set(${out_source} "${source}" PARENT_SCOPE)
    set(${out_patches} "${patches}" PARENT_SCOPE)
endfunction()

# Refuses the <library> artifact at <directory> when its record differs from
# the expected one; <rebuild> names the command that makes it current.
function(bblite_verify_patch_record library directory rebuild)
    file(READ "${BBLITE_PATCH_MANIFEST}" manifest)
    string(JSON prefix GET "${manifest}" libraries ${library} record prefix)
    string(JSON record_file GET "${manifest}" libraries ${library} record file)
    unset(${prefix}_SOURCE)
    unset(${prefix}_PATCHES)
    if(EXISTS "${directory}/${record_file}")
        include("${directory}/${record_file}")
    endif()
    if(NOT DEFINED ${prefix}_PATCHES)
        message(
            WARNING
            "The ${library} install at ${directory} records no patch set, so its "
            "source and patches cannot be verified. Rebuild it with ${rebuild} "
            "to record them."
        )
        return()
    endif()
    bblite_expected_patch_record(${library} expected_source expected_patches ${ARGN})
    if(
        NOT "${${prefix}_SOURCE}" STREQUAL "${expected_source}"
        OR NOT "${${prefix}_PATCHES}" STREQUAL "${expected_patches}"
    )
        message(
            FATAL_ERROR
            "The ${library} install at ${directory} was built from "
            "'${${prefix}_SOURCE}' with the patch set [${${prefix}_PATCHES}], but "
            "the pin and native/patches/manifest.json now select "
            "'${expected_source}' with [${expected_patches}]. Rebuild it with "
            "${rebuild}."
        )
    endif()
endfunction()

# Verifies every prebuilt artifact this configuration consumes, with the
# variant tokens its builder selected patches by.
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
        bblite_verify_patch_record(dawn "${BBLITE_DAWN_DIR}" "${dawn_rebuild}" ${dawn_variants})
    endif()
    if(BBLITE_SDL_DIR)
        bblite_verify_patch_record(sdl3 "${BBLITE_SDL_DIR}" "tools/build-sdl-min.ps1" trimmed)
    endif()
    if("audio:engine" IN_LIST BBLITE_RUNTIME_FEATURES)
        set(labsound_variants "")
        if(BBLITE_LABSOUND_CORE_ONLY)
            list(APPEND labsound_variants core-only)
        endif()
        bblite_verify_patch_record(
            labsound "${BBLITE_LABSOUND_DIR}" "tools/build-labsound.ps1" ${labsound_variants}
        )
    endif()
    if("ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES)
        bblite_verify_patch_record(rmlui "${BBLITE_RMLUI_DIR}" "${BBLITE_RMLUI_BUILD_COMMAND}")
    endif()
endfunction()
