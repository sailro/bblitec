# bblite-tint (main.cc): the pinned Tint's HLSL, MSL and SPIR-V writers driven
# with SDL_GPU's binding layout. tools/build-tint.ps1 configures this project
# over its patched Dawn checkout, which also builds the pinned `tint` command.
cmake_minimum_required(VERSION 3.22)
project(bblite_tint LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(BBLITE_DAWN_SOURCE "" CACHE PATH "The patched Dawn checkout carrying the pinned Tint")
if(NOT IS_DIRECTORY "${BBLITE_DAWN_SOURCE}/src/tint")
  message(FATAL_ERROR "BBLITE_DAWN_SOURCE must name the Dawn checkout tools/build-tint.ps1 prepares.")
endif()
add_subdirectory("${BBLITE_DAWN_SOURCE}" dawn)

add_executable(bblite_tint main.cc)
set_target_properties(bblite_tint PROPERTIES OUTPUT_NAME bblite-tint)
if(MSVC)
  # Tint's headers need the warnings Tint disables for its own targets off:
  # padded aligned structures, constant conditions, narrowing and shadowing.
  target_compile_options(bblite_tint PRIVATE /W4 /WX /wd4127 /wd4244 /wd4267 /wd4324 /wd4458 /wd4459)
else()
  # The warnings Tint's own targets build with.
  target_compile_options(bblite_tint PRIVATE -Wall -Wextra -Wno-padded -Wno-switch-enum -Wno-unknown-pragmas)
endif()
target_link_libraries(bblite_tint PRIVATE
  tint_api
  tint_api_common
  tint_cmd_common
  tint_lang_core
  tint_lang_core_ir
  tint_lang_core_ir_transform
  tint_lang_hlsl_writer
  tint_lang_hlsl_writer_common
  tint_lang_msl_writer
  tint_lang_msl_writer_common
  tint_lang_spirv_writer
  tint_lang_spirv_writer_common
  tint_lang_core_type
  tint_lang_wgsl
  tint_lang_wgsl_ast
  tint_lang_wgsl_inspector
  tint_lang_wgsl_program
  tint_lang_wgsl_reader
  tint_lang_wgsl_reader_program_to_ir
  tint_lang_wgsl_sem
  tint_utils
  tint_utils_diagnostic
  tint_utils_text
  SPIRV-Tools
)
