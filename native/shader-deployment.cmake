# The executable and deployment checks read this same backend selection.
set(BBLITE_DEPLOYED_SHADER_SUFFIXES ".slots")
if(BBLITE_BACKEND_SDL_GPU)
    if(WIN32)
        list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".dxil")
    elseif(APPLE)
        list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".msl")
    else()
        list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".spv")
    endif()
endif()
if(BBLITE_BACKEND_DAWN)
    list(APPEND BBLITE_DEPLOYED_SHADER_SUFFIXES ".native.wgsl")
endif()
set(BBLITE_DEPLOYED_SHADER_SUFFIXES "${BBLITE_DEPLOYED_SHADER_SUFFIXES}" CACHE INTERNAL
    "Shader file suffixes the compiled renderers read")

set(shader_root "${BBLITE_GENERATED_DIR}/upstream/shaders")
set(shader_patterns "")
foreach(suffix IN LISTS BBLITE_DEPLOYED_SHADER_SUFFIXES)
    list(APPEND shader_patterns "${shader_root}/*${suffix}")
endforeach()
file(GLOB_RECURSE shader_files CONFIGURE_DEPENDS LIST_DIRECTORIES false ${shader_patterns})

# GLOB_RECURSE sorts its result. Membership changes invalidate the deploy even
# when a cached file has an older mtime; excluded intermediates never do.
set(shader_manifest "${CMAKE_CURRENT_BINARY_DIR}/bblite-generated-shaders.manifest")
set(shader_names "")
foreach(source IN LISTS shader_files)
    file(RELATIVE_PATH name "${shader_root}" "${source}")
    list(APPEND shader_names "${name}")
endforeach()
string(JOIN "\n" shader_list ${shader_names})
file(GENERATE OUTPUT "${shader_manifest}" CONTENT "${shader_list}")

set(deploy_stamp "${CMAKE_CURRENT_BINARY_DIR}/bblite-shaders-deployed.stamp")
add_custom_command(
    OUTPUT "${deploy_stamp}"
    COMMAND "${CMAKE_COMMAND}"
        "-DBBLITE_SOURCE=${shader_root}"
        "-DBBLITE_DESTINATION=$<TARGET_FILE_DIR:bblite_native>/shaders"
        "-DBBLITE_MANIFEST=${shader_manifest}"
        -P "${CMAKE_CURRENT_LIST_DIR}/deploy-shaders.cmake"
    COMMAND "${CMAKE_COMMAND}" -E touch "${deploy_stamp}"
    DEPENDS ${shader_files} "${shader_manifest}" "${CMAKE_CURRENT_LIST_DIR}/deploy-shaders.cmake"
    VERBATIM
)
add_custom_target(bblite_shader_deploy ALL DEPENDS "${deploy_stamp}")
add_dependencies(bblite_shader_deploy bblite_native)
