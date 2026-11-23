cmake_minimum_required(VERSION 3.24)
set(BBLITE_GENERATED_DIR "" CACHE PATH "Generated fixture input")
project(shipping_iteration LANGUAGES CXX)
add_executable(bblite_native main.cpp edited.cpp)
set(BBLITE_BACKEND_SDL_GPU ON)
include("${CMAKE_CURRENT_LIST_DIR}/shader-deployment.cmake")
add_custom_target(assets ALL
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/assets"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${BBLITE_GENERATED_DIR}/assets/texture.bin" "${CMAKE_CURRENT_BINARY_DIR}/assets/texture.bin"
    VERBATIM)
