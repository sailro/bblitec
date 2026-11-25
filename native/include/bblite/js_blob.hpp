#pragma once

// The File API's Blob value: immutable bytes and a MIME type, and its structured clone. A dynamic
// value holds one as itself (js_json.hpp); js_file.hpp adds object URLs and reading.

#include <bblite/js_data.hpp>
#include <bblite/js_structured_clone.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::js {

inline constexpr std::size_t maximum_blob_bytes = 64u * 1024u * 1024u;

/** One already-encoded string or byte view supplied to the Blob constructor. */
class BlobPart {
public:
    explicit BlobPart(const std::string& value)
        : data_(reinterpret_cast<const std::uint8_t*>(value.data())), size_(value.size()) {}
    explicit BlobPart(const U8Array& value) : data_(value.data()), size_(value.size()) {}
    explicit BlobPart(const ArrayBuffer& value) : data_(value.data()), size_(value.byte_length()) {}
    /** A typed view's bytes, which the view (not its buffer handle) keeps alive. */
    template <typename T>
    explicit BlobPart(const TypedArray<T>& value) : size_(value.byte_length()) {
        const ArrayBuffer buffer = value.buffer();
        data_ = buffer.data() + value.byte_offset();
    }

    [[nodiscard]] const std::uint8_t* data() const noexcept { return data_; }
    [[nodiscard]] std::size_t size() const noexcept { return size_; }

private:
    const std::uint8_t* data_ = nullptr;
    std::size_t size_ = 0;
};

[[nodiscard]] inline BlobPart blob_part_string(const std::string& value) { return BlobPart(value); }

[[nodiscard]] inline BlobPart blob_part_bytes(const U8Array& value) { return BlobPart(value); }

[[nodiscard]] inline BlobPart blob_part_bytes(const ArrayBuffer& value) { return BlobPart(value); }

/**
 * Native Blob value. Construction concatenates in source order and is bounded
 * before every append, so an overflowing part cannot wrap the size check.
 */
class Blob {
public:
    Blob() : Blob({}, "") {}
    Blob(std::initializer_list<BlobPart> parts, std::string mime_type)
        : bytes_(concatenate(parts)), mime_type_(normalize_type(std::move(mime_type))) {}

    /**
     * `new Blob(parts, { type })` over a run-time list of strings, byte views or buffers. A type
     * with a character outside U+0020-U+007E is the empty string (File API); others lowercase.
     */
    template <typename Parts>
    [[nodiscard]] static Blob from_parts(const Parts& parts, std::string type) {
        std::vector<BlobPart> views;
        views.reserve(std::size(parts));
        for (const auto& part : parts)
            views.emplace_back(part);
        Blob blob;
        blob.bytes_ = concatenate(views);
        blob.mime_type_ =
            std::any_of(type.begin(), type.end(),
                        [](unsigned char byte) { return byte < 0x20u || byte > 0x7eu; })
                ? std::string()
                : normalize_type(std::move(type));
        return blob;
    }

    /** A Blob holding `bytes` as they are, as a structured clone receives one. */
    [[nodiscard]] static Blob from_bytes(std::vector<std::uint8_t> bytes, std::string type) {
        if (bytes.size() > maximum_blob_bytes)
            throw std::runtime_error("Blob exceeds the native 64 MiB payload bound.");
        Blob blob;
        blob.bytes_ = std::make_shared<const std::vector<std::uint8_t>>(std::move(bytes));
        blob.mime_type_ = normalize_type(std::move(type));
        return blob;
    }

    [[nodiscard]] std::size_t size() const noexcept { return bytes_->size(); }
    [[nodiscard]] const std::string& type() const noexcept { return mime_type_; }
    [[nodiscard]] const std::vector<std::uint8_t>& bytes() const noexcept { return *bytes_; }
    [[nodiscard]] const std::shared_ptr<const std::vector<std::uint8_t>>& payload() const noexcept {
        return bytes_;
    }
    [[nodiscard]] const void* get() const noexcept { return bytes_.get(); }
    explicit operator bool() const noexcept { return true; }
    [[nodiscard]] bool operator==(const Blob& other) const noexcept {
        return bytes_ == other.bytes_;
    }

private:
    template <typename Parts>
    [[nodiscard]] static std::shared_ptr<const std::vector<std::uint8_t>>
    concatenate(const Parts& parts) {
        std::size_t size = 0;
        for (const BlobPart& part : parts) {
            if (part.size() > maximum_blob_bytes - size) {
                throw std::runtime_error("Blob exceeds the native 64 MiB payload bound.");
            }
            size += part.size();
        }
        auto bytes = std::make_shared<std::vector<std::uint8_t>>();
        bytes->reserve(size);
        for (const BlobPart& part : parts) {
            if (part.size() != 0u) {
                bytes->insert(bytes->end(), part.data(), part.data() + part.size());
            }
        }
        return bytes;
    }
    [[nodiscard]] static std::string normalize_type(std::string value) {
        for (char& character : value) {
            const auto byte = static_cast<unsigned char>(character);
            if (byte < 0x20u || byte > 0x7eu) {
                throw std::runtime_error("Blob MIME type must contain printable ASCII text.");
            }
            if (byte >= 'A' && byte <= 'Z') {
                character = static_cast<char>(byte - 'A' + 'a');
            }
        }
        return value;
    }

    std::shared_ptr<const std::vector<std::uint8_t>> bytes_;
    std::string mime_type_;
};

/** A Blob clones as its type and bytes, and is received as a new Blob holding them. */
template <> struct CloneCodec<Blob> {
    static pal::CloneId write(pal::CloneWriter& writer, const Blob& value) {
        return writer.add(pal::CloneBlob{value.type(), value.bytes()});
    }
    static Blob read(pal::CloneReader& reader, pal::CloneId id) {
        const auto& blob = reader.get<pal::CloneBlob>(id);
        return Blob::from_bytes(blob.bytes, blob.type);
    }
};

} // namespace bbl::js
