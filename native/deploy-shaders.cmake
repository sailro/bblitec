# Replaces the shader directory beside an executable with the snapshot files
# its compiled renderers read, run by native/CMakeLists.txt after each shader
# snapshot:
#
#   BBLITE_SOURCE       the build's shader snapshot directory
#   BBLITE_DESTINATION  the executable's shader directory
#   BBLITE_SUFFIXES     the deployed file-name suffixes (the table beside the
#                       deploy target in CMakeLists.txt)
#
# The copy runs from a script because a scene's shader set can outgrow a
# command line (hundreds of files).
if(NOT BBLITE_SUFFIXES)
    message(FATAL_ERROR "No compiled renderer names a deployed shader suffix.")
endif()
set(matching "")
foreach(suffix IN LISTS BBLITE_SUFFIXES)
    list(APPEND matching PATTERN "*${suffix}")
endforeach()
file(REMOVE_RECURSE "${BBLITE_DESTINATION}")
file(MAKE_DIRECTORY "${BBLITE_DESTINATION}")
file(COPY "${BBLITE_SOURCE}/" DESTINATION "${BBLITE_DESTINATION}" FILES_MATCHING ${matching})
