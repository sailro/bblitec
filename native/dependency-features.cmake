# Image codecs reached by the scene's materialized assets: generation
# writes the list into features.cmake, and a tree without one is not a
# tree this file knows how to build.
if(NOT DEFINED BBLITE_IMAGE_CODECS)
    message(
        FATAL_ERROR
        "${BBLITE_GENERATED_DIR}/features.cmake carries no BBLITE_IMAGE_CODECS "
        "list; regenerate the scene (scene -- compile <id>)."
    )
endif()
set(BBLITE_HAS_IMAGE_DECODER OFF)
if(BBLITE_IMAGE_CODECS)
    set(BBLITE_HAS_IMAGE_DECODER ON)
endif()
set(BBLITE_REQUIRED_IMAGE_CODECS ${BBLITE_IMAGE_CODECS})
if(BBLITE_VISUAL_CAPTURE)
    list(APPEND BBLITE_REQUIRED_IMAGE_CODECS "png")
endif()
file(READ "${BBLITE_NATIVE_ROOT}/vcpkg.json" BBLITE_DEPENDENCY_MANIFEST)
foreach(BBLITE_IMAGE_CODEC IN LISTS BBLITE_REQUIRED_IMAGE_CODECS)
    string(JSON BBLITE_CODEC_METADATA_TYPE ERROR_VARIABLE BBLITE_CODEC_ERROR
        TYPE "${BBLITE_DEPENDENCY_MANIFEST}" features "${BBLITE_IMAGE_CODEC}" "$bblite-image")
    if(BBLITE_CODEC_ERROR OR NOT BBLITE_CODEC_METADATA_TYPE STREQUAL "OBJECT")
        message(FATAL_ERROR "Unknown BBLITE_IMAGE_CODECS entry '${BBLITE_IMAGE_CODEC}'; regenerate the scene.")
    endif()
    if(NOT "${BBLITE_IMAGE_CODEC}" IN_LIST VCPKG_MANIFEST_FEATURES)
        list(APPEND VCPKG_MANIFEST_FEATURES "${BBLITE_IMAGE_CODEC}")
    endif()
endforeach()

# The rigid-body solver, selected the same way and for the same reason: a
# scene that creates no physics world installs and links nothing.
if(
    "physics:world" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT "physics" IN_LIST VCPKG_MANIFEST_FEATURES
)
    list(APPEND VCPKG_MANIFEST_FEATURES "physics")
endif()

# The navigation toolset, same shape: a scene that creates no navigation
# plugin installs and links nothing.
if(
    "navigation:recast" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT "navigation" IN_LIST VCPKG_MANIFEST_FEATURES
)
    list(APPEND VCPKG_MANIFEST_FEATURES "navigation")
endif()
foreach(BBLITE_NAV_COMPONENT IN ITEMS "crowd" "tile-cache")
    if("navigation:${BBLITE_NAV_COMPONENT}" IN_LIST BBLITE_RUNTIME_FEATURES)
        list(APPEND VCPKG_MANIFEST_FEATURES "navigation-${BBLITE_NAV_COMPONENT}")
    endif()
endforeach()

# Scene-created DOM lowers to a retained UI IR. Only that reached surface
# installs the font dependency and composes RmlUi into the executable.
if(
    "ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES
    AND NOT "ui" IN_LIST VCPKG_MANIFEST_FEATURES
)
    list(APPEND VCPKG_MANIFEST_FEATURES "ui")
endif()
if("ui:rml" IN_LIST BBLITE_RUNTIME_FEATURES AND
   ("ui:inline-svg" IN_LIST BBLITE_RUNTIME_FEATURES OR NOT BBLITE_MINSIZE) AND
   NOT "ui-svg" IN_LIST VCPKG_MANIFEST_FEATURES)
    list(APPEND VCPKG_MANIFEST_FEATURES "ui-svg")
endif()

if("text:layout" IN_LIST BBLITE_RUNTIME_FEATURES AND NOT "text-layout" IN_LIST VCPKG_MANIFEST_FEATURES)
    list(APPEND VCPKG_MANIFEST_FEATURES "text-layout")
endif()
