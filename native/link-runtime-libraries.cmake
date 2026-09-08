# Places runtime libraries beside an executable as hard links (copies where
# the file system refuses a link), run by native/CMakeLists.txt after each
# link of bblite_native:
#
#   BBLITE_FILES        explicit files to place (the Dawn DLLs)
#   BBLITE_DIRECTORY    a directory whose *.dll are all placed (the vcpkg
#                       bin directory); empty or absent skips
#   BBLITE_DESTINATION  the executable's directory
#
# A hard link keeps the linked file current with its source while the
# source is rewritten in place; a source replaced by a new file (a rebuilt
# Dawn, a reinstalled port) reaches the tree at its next link, exactly
# when a copy would have.
set(files ${BBLITE_FILES})
if(BBLITE_DIRECTORY AND EXISTS "${BBLITE_DIRECTORY}")
    file(GLOB installed_libraries "${BBLITE_DIRECTORY}/*.dll")
    list(APPEND files ${installed_libraries})
endif()
foreach(library IN LISTS files)
    if(NOT EXISTS "${library}")
        message(FATAL_ERROR "Runtime library not found: ${library}")
    endif()
    get_filename_component(name "${library}" NAME)
    file(CREATE_LINK "${library}" "${BBLITE_DESTINATION}/${name}" COPY_ON_ERROR)
endforeach()
