// The one translation unit that includes the generated build stamp.
//
// The stamp digest changes with every generated tree, so any object whose
// preprocessed text contains it must recompile per scene. Keeping the
// include here — and handing everyone else the string through
// `bblite_build_stamp()` — is what keeps the GPU PAL objects
// byte-identical across scenes; this file is meant to recompile per
// scene, and only this file.
#include <bblite/pal.hpp>
#include <bblite/upstream/build_stamp.hpp>

namespace bbl::pal {

const char* bblite_build_stamp() {
    return BBLITE_BUILD_STAMP;
}

} // namespace bbl::pal
