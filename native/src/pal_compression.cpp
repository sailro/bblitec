#include <bblite/pal_compression.hpp>

#include <algorithm>
#include <limits>
#include <new>
#include <stdexcept>

#define ZLIB_CONST
#include <zlib.h>

namespace bbl::pal {
namespace {

/** One output chunk per filled buffer, as Chromium's transformers enqueue them (64 KiB). */
constexpr std::size_t output_buffer = 64u * 1024u;
/** Chromium's CompressionStream deflate level. */
constexpr int compression_level = 6;
constexpr int window_bits = 15;

/** The zlib window bits of a CompressionFormat: zlib wrapper, raw, or gzip wrapper. */
int format_window_bits(const std::string& format, const char* constructor) {
    if (format == "deflate")
        return window_bits;
    if (format == "deflate-raw")
        return -window_bits;
    if (format == "gzip")
        return window_bits + 16;
    throw js::NamedError("TypeError", std::string("Failed to construct '") + constructor +
                                          "': Unsupported compression format: '" + format + "'");
}

js::NamedError type_error(std::string message) {
    return js::NamedError("TypeError", std::move(message));
}

/**
 * Run `step` over `input` in slices zlib's 32-bit counts hold, collecting each filled output
 * buffer as a chunk. `step` returns false to stop before the input is consumed.
 */
template <typename Step>
void run_zlib(z_stream& stream, std::span<const std::uint8_t> input,
              std::deque<std::vector<std::uint8_t>>& output, Step step) {
    constexpr std::size_t slice = (std::numeric_limits<uInt>::max)();
    std::size_t offset = 0;
    do {
        const auto length = (std::min)(slice, input.size() - offset);
        stream.next_in = input.data() + offset;
        stream.avail_in = static_cast<uInt>(length);
        const bool last = offset + length == input.size();
        offset += length;
        for (;;) {
            std::vector<std::uint8_t> chunk(output_buffer);
            stream.next_out = chunk.data();
            stream.avail_out = static_cast<uInt>(chunk.size());
            const bool more = step(last);
            chunk.resize(chunk.size() - stream.avail_out);
            const bool filled = stream.avail_out == 0;
            if (!chunk.empty())
                output.push_back(std::move(chunk));
            if (!more)
                return;
            if (!filled)
                break;
        }
    } while (offset < input.size());
}

class Deflater final : public ByteTransformer {
public:
    explicit Deflater(int bits) {
        const auto status =
            deflateInit2(&stream_, compression_level, Z_DEFLATED, bits, 8, Z_DEFAULT_STRATEGY);
        if (status == Z_MEM_ERROR)
            throw std::bad_alloc();
        if (status != Z_OK)
            throw std::runtime_error("zlib deflate initialization failed.");
    }
    Deflater(const Deflater&) = delete;
    Deflater& operator=(const Deflater&) = delete;
    ~Deflater() override { deflateEnd(&stream_); }

    void transform(std::span<const std::uint8_t> input,
                   std::deque<std::vector<std::uint8_t>>& output) override {
        deflate_input(input, Z_NO_FLUSH, output);
    }
    void flush(std::deque<std::vector<std::uint8_t>>& output) override {
        deflate_input({}, Z_FINISH, output);
    }

private:
    void deflate_input(std::span<const std::uint8_t> input, int mode,
                       std::deque<std::vector<std::uint8_t>>& output) {
        run_zlib(stream_, input, output, [&](bool last) {
            const auto status = deflate(&stream_, last ? mode : Z_NO_FLUSH);
            if (status != Z_OK && status != Z_STREAM_END && status != Z_BUF_ERROR)
                throw std::runtime_error("zlib deflate failed.");
            return true;
        });
    }
    z_stream stream_{};
};

/** Chromium's InflateTransformer: one stream, with its TypeError messages. */
class Inflater final : public ByteTransformer {
public:
    explicit Inflater(int bits) {
        const auto status = inflateInit2(&stream_, bits);
        if (status == Z_MEM_ERROR)
            throw std::bad_alloc();
        if (status != Z_OK)
            throw std::runtime_error("zlib inflate initialization failed.");
    }
    Inflater(const Inflater&) = delete;
    Inflater& operator=(const Inflater&) = delete;
    ~Inflater() override { inflateEnd(&stream_); }

    void transform(std::span<const std::uint8_t> input,
                   std::deque<std::vector<std::uint8_t>>& output) override {
        inflate_input(input, Z_NO_FLUSH, output);
    }
    void flush(std::deque<std::vector<std::uint8_t>>& output) override {
        if (!ended_)
            inflate_input({}, Z_FINISH, output);
        if (!ended_)
            throw type_error("Compressed input was truncated.");
    }

private:
    void inflate_input(std::span<const std::uint8_t> input, int mode,
                       std::deque<std::vector<std::uint8_t>>& output) {
        if (ended_ && !input.empty())
            throw type_error("Junk found after end of compressed data.");
        run_zlib(stream_, input, output, [&](bool last) {
            const auto status = inflate(&stream_, last ? mode : Z_NO_FLUSH);
            if (status == Z_DATA_ERROR)
                throw type_error(std::string("The compressed data was not valid: ") +
                                 (stream_.msg ? stream_.msg : "invalid data") + ".");
            if (status != Z_OK && status != Z_STREAM_END && status != Z_BUF_ERROR)
                throw type_error("The compressed data was not valid.");
            if (status != Z_STREAM_END)
                return true;
            ended_ = true;
            if (stream_.avail_in != 0 || !last)
                throw type_error("Junk found after end of compressed data.");
            return false;
        });
    }
    z_stream stream_{};
    bool ended_ = false;
};

} // namespace

ByteTransformStream compression_stream(const std::string& format) {
    return ByteTransformStream(
        std::make_unique<Deflater>(format_window_bits(format, "CompressionStream")));
}

ByteTransformStream decompression_stream(const std::string& format) {
    return ByteTransformStream(
        std::make_unique<Inflater>(format_window_bits(format, "DecompressionStream")));
}

} // namespace bbl::pal
