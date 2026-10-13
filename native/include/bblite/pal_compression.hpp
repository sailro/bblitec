#pragma once

// Compression Streams over zlib (`pal_compression.cpp`), linked only where a program constructs
// a CompressionStream or DecompressionStream (platform:compression).

#include <bblite/pal_fetch_response.hpp>

#include <string>

namespace bbl::pal {

/**
 * `new CompressionStream(format)`: zlib deflate at level 6 (Chromium's) into a "gzip",
 * "deflate" or "deflate-raw" stream. Another format throws TypeError.
 */
[[nodiscard]] ByteTransformStream compression_stream(const std::string& format);

/**
 * `new DecompressionStream(format)`: zlib inflate of one "gzip", "deflate" or "deflate-raw"
 * stream. Invalid data, input after the stream's end and a truncated stream error the readable
 * side with a TypeError; another format throws TypeError.
 */
[[nodiscard]] ByteTransformStream decompression_stream(const std::string& format);

} // namespace bbl::pal
