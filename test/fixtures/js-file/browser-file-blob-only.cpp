#include <bblite/js_file.hpp>

void compile_blob_without_retained_ui() {
    const bbl::js::Blob blob(
        {bbl::js::blob_part_string("bytes")},
        "text/plain");
    static_cast<void>(blob);
}
