cmake_minimum_required(VERSION 3.24)
project(bblite_ios_file_test LANGUAGES CXX OBJCXX)
if(NOT IOS)
    message(FATAL_ERROR "This fixture requires an iOS SDK.")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_OBJCXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
get_filename_component(BBLITE_NATIVE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../native" ABSOLUTE)
find_package(SDL3 CONFIG REQUIRED)
find_package(boost_charconv CONFIG REQUIRED)
find_library(UIKIT UIKit REQUIRED)
find_library(TYPES UniformTypeIdentifiers REQUIRED)
find_library(FOUNDATION Foundation REQUIRED)
execute_process(COMMAND xcrun --sdk iphonesimulator clang -print-resource-dir
    OUTPUT_VARIABLE CLANG_RESOURCES OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
find_library(IOS_RUNTIME NAMES clang_rt.iossim PATHS "${CLANG_RESOURCES}/lib/darwin"
    NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH REQUIRED)
add_executable(ios_file_test MACOSX_BUNDLE main.mm
    "${BBLITE_NATIVE_ROOT}/src/pal_file.cpp" "${BBLITE_NATIVE_ROOT}/src/pal_file_ios.mm")
target_include_directories(ios_file_test PRIVATE "${BBLITE_NATIVE_ROOT}/include")
target_compile_options(ios_file_test PRIVATE -Wall -Wextra -Wpedantic -Werror
    $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_compile_definitions(ios_file_test PRIVATE BBLITE_HAS_UI=0 BBLITE_HAS_BROWSER_FILE=1)
target_link_libraries(ios_file_test PRIVATE SDL3::SDL3 Boost::charconv "${UIKIT}" "${TYPES}" "${FOUNDATION}" "${IOS_RUNTIME}")
set_target_properties(ios_file_test PROPERTIES MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_LIST_DIR}/Info.plist"
    XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED NO)
