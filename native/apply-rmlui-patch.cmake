find_package(Git REQUIRED)

# Stage the maintained patch in this disposable dependency checkout. The next
# forced checkout of the pin then removes files added by an older patch version,
# as well as restoring modified files. Index checks still reject local divergence.
execute_process(
    COMMAND
        "${GIT_EXECUTABLE}" -C "${RMLUI_SOURCE_DIR}" apply --index --unidiff-zero --check
        "${RMLUI_PATCH}"
    RESULT_VARIABLE patch_applies
    OUTPUT_QUIET
    ERROR_QUIET
)

if(patch_applies EQUAL 0)
    execute_process(
        COMMAND
            "${GIT_EXECUTABLE}" -C "${RMLUI_SOURCE_DIR}" apply --index --unidiff-zero
            "${RMLUI_PATCH}"
        RESULT_VARIABLE patch_result
    )
    if(NOT patch_result EQUAL 0)
        message(FATAL_ERROR "Failed to apply the pinned RmlUi patch.")
    endif()
else()
    execute_process(
        COMMAND
            "${GIT_EXECUTABLE}" -C "${RMLUI_SOURCE_DIR}" apply --index --unidiff-zero
            --check --reverse "${RMLUI_PATCH}"
        RESULT_VARIABLE patch_is_present
        OUTPUT_QUIET
        ERROR_QUIET
    )
    if(NOT patch_is_present EQUAL 0)
        message(
            FATAL_ERROR
            "The pinned RmlUi patch neither applies cleanly nor is already present."
        )
    endif()
endif()
