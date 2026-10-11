# featureSources selects canonical SDL_GPU unit names. Resolve only the
# compiled backends; an unselected backend's source files need not exist.
# Scene families share one translation unit to parse their state header once.
list(TRANSFORM BBLITE_RUNTIME_SOURCES REPLACE "/src/pal_sdl_gpu\\.cpp$" "/src/pal_sdl_gpu_scene_all.cpp")
if("platform:window" IN_LIST BBLITE_RUNTIME_FEATURES)
    list(APPEND BBLITE_RUNTIME_SOURCES "${BBLITE_NATIVE_ROOT}/src/pal_sdl_gpu_window_presenter.cpp")
endif()
set(BBLITE_SDL_GPU_SOURCES ${BBLITE_RUNTIME_SOURCES})
set(BBLITE_GPU_SOURCE_PATTERN "/src/pal_sdl_gpu[^/]*\\.cpp$")
list(FILTER BBLITE_SDL_GPU_SOURCES INCLUDE REGEX "${BBLITE_GPU_SOURCE_PATTERN}")
set(BBLITE_DAWN_SOURCES "")
if(BBLITE_BACKEND_DAWN)
    foreach(bblite_sdl_gpu_source IN LISTS BBLITE_SDL_GPU_SOURCES)
        string(REPLACE "/src/pal_sdl_gpu" "/src/pal_dawn" bblite_dawn_source "${bblite_sdl_gpu_source}")
        if(NOT EXISTS "${bblite_dawn_source}")
            message(FATAL_ERROR "The selected Dawn backend needs ${bblite_dawn_source}.")
        endif()
        list(APPEND BBLITE_DAWN_SOURCES "${bblite_dawn_source}")
    endforeach()
endif()
if(NOT BBLITE_BACKEND_SDL_GPU)
    list(FILTER BBLITE_RUNTIME_SOURCES EXCLUDE REGEX "${BBLITE_GPU_SOURCE_PATTERN}")
endif()
# Shared GPU concerns are needed by every renderer and the window presenter.
if(BBLITE_SDL_GPU_SOURCES)
    list(
        APPEND BBLITE_RUNTIME_SOURCES
        "${BBLITE_NATIVE_ROOT}/src/pal_gpu_frame.cpp"
        "${BBLITE_NATIVE_ROOT}/src/pal_gpu_images.cpp"
        "${BBLITE_NATIVE_ROOT}/src/pal_gpu_shared.cpp"
    )
endif()
