#pragma once

// The bounded JavaScript File API slice reached by generated applications.
// Blob and opaque handles live here; dialogs, selected-path reads, and atomic
// writes stay behind pal.hpp. No source-supplied path enters this interface.

#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::js {

inline constexpr std::size_t maximum_blob_bytes = 64u * 1024u * 1024u;
inline constexpr std::size_t maximum_object_urls = 4096u;

/** One already-encoded string or byte view supplied to the Blob constructor. */
class BlobPart {
  public:
    explicit BlobPart(const std::string& value)
        : data_(reinterpret_cast<const std::uint8_t*>(value.data())),
          size_(value.size()) {}
    explicit BlobPart(const U8Array& value)
        : data_(value.data()), size_(value.size()) {}
    explicit BlobPart(const ArrayBuffer& value)
        : data_(value.data()), size_(value.byte_length()) {}

    [[nodiscard]] const std::uint8_t* data() const noexcept { return data_; }
    [[nodiscard]] std::size_t size() const noexcept { return size_; }

  private:
    const std::uint8_t* data_ = nullptr;
    std::size_t size_ = 0;
};

[[nodiscard]] inline BlobPart blob_part_string(const std::string& value) {
    return BlobPart(value);
}

[[nodiscard]] inline BlobPart blob_part_bytes(const U8Array& value) {
    return BlobPart(value);
}

[[nodiscard]] inline BlobPart blob_part_bytes(const ArrayBuffer& value) {
    return BlobPart(value);
}

/**
 * Native Blob value. Construction concatenates in source order and is bounded
 * before every append, so an overflowing part cannot wrap the size check.
 */
class Blob {
  public:
    Blob(
        std::initializer_list<BlobPart> parts,
        std::string mime_type)
        : mime_type_(normalize_type(std::move(mime_type))) {
        std::size_t size = 0;
        for (const BlobPart& part : parts) {
            if (part.size() > maximum_blob_bytes - size) {
                throw std::runtime_error(
                    "Blob exceeds the native 64 MiB payload bound.");
            }
            size += part.size();
        }
        auto bytes = std::make_shared<std::vector<std::uint8_t>>();
        bytes->reserve(size);
        for (const BlobPart& part : parts) {
            if (part.size() != 0u) {
                bytes->insert(
                    bytes->end(),
                    part.data(),
                    part.data() + part.size());
            }
        }
        bytes_ = std::move(bytes);
    }

    [[nodiscard]] std::size_t size() const noexcept { return bytes_->size(); }
    [[nodiscard]] const std::string& type() const noexcept {
        return mime_type_;
    }
    [[nodiscard]] const std::vector<std::uint8_t>& bytes() const noexcept {
        return *bytes_;
    }
    [[nodiscard]] const std::shared_ptr<const std::vector<std::uint8_t>>&
    payload() const noexcept {
        return bytes_;
    }

  private:
    [[nodiscard]] static std::string normalize_type(std::string value) {
        for (char& character : value) {
            const auto byte = static_cast<unsigned char>(character);
            if (byte < 0x20u || byte > 0x7eu) {
                throw std::runtime_error(
                    "Blob MIME type must contain printable ASCII text.");
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

[[nodiscard]] inline ObjectUrlRecord& object_url_record(
    Engine& engine,
    ObjectUrlHandle handle) {
    if (handle.slot >= engine.object_urls.size()) {
        throw std::runtime_error(
            "Native object URL is unknown or has been revoked.");
    }
    ObjectUrlRecord& record = engine.object_urls[handle.slot];
    if (
        !record.active ||
        handle.generation == 0 ||
        record.generation != handle.generation) {
        throw std::runtime_error(
            "Native object URL is unknown or has been revoked.");
    }
    return record;
}

/** Each call mints a distinct URL identity, even for the same Blob value. */
[[nodiscard]] inline ObjectUrlHandle create_object_url(
    Engine& engine,
    const Blob& blob) {
    const auto bytes = blob.payload();
    std::string mime_type = blob.type();
    std::uint32_t slot = invalid_handle;
    if (!engine.free_object_url_slots.empty()) {
        slot = engine.free_object_url_slots.back();
        engine.free_object_url_slots.pop_back();
    } else {
        if (engine.object_urls.size() >= maximum_object_urls) {
            throw std::runtime_error(
                "Native object URL registry exceeds its 4096-entry bound.");
        }
        slot = static_cast<std::uint32_t>(engine.object_urls.size());
        engine.object_urls.emplace_back();
    }
    ObjectUrlRecord& record = engine.object_urls[slot];
    record.bytes = bytes;
    record.mime_type = std::move(mime_type);
    record.active = true;
    return ObjectUrlHandle{slot, record.generation};
}

/**
 * Browser revocation is idempotent. A stale generation is ignored, while a
 * later use of that token is rejected by object_url_record.
 */
inline void revoke_object_url(Engine& engine, ObjectUrlHandle handle) {
    if (handle.slot >= engine.object_urls.size()) return;
    ObjectUrlRecord& record = engine.object_urls[handle.slot];
    if (!record.active || record.generation != handle.generation) return;
    record.active = false;
    record.bytes.reset();
    record.mime_type.clear();
    if (record.generation != (std::numeric_limits<std::uint32_t>::max)()) {
        ++record.generation;
        engine.free_object_url_slots.push_back(handle.slot);
    }
}

/** One immutable snapshot of an input's selected files. */
struct FileList {
    BrowserFileHandle first{};

    [[nodiscard]] std::size_t length() const noexcept {
        return first ? 1u : 0u;
    }
};

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
[[nodiscard]] inline UiElementRecord& browser_file_ui_element(
    Engine& engine,
    UiElementHandle handle) {
    if (handle.value >= engine.ui_elements.size()) {
        throw std::runtime_error("Native browser-file UI handle is out of range.");
    }
    return engine.ui_elements[handle.value];
}

[[nodiscard]] inline FileList input_files(
    Engine& engine,
    UiElementHandle input) {
    const UiElementRecord& element =
        browser_file_ui_element(engine, input);
    if (element.tag != "input" || !element.file_input) {
        throw std::runtime_error(
            "Native files list requires an <input type=\"file\">.");
    }
    return FileList{element.selected_file};
}
#endif

[[nodiscard]] inline BrowserFileHandle file_at(
    const FileList& files,
    std::size_t index) {
    return index == 0u ? files.first : BrowserFileHandle{};
}

[[nodiscard]] inline const BrowserFileRecord& browser_file_record(
    const Engine& engine,
    const BrowserFileHandle& handle) {
    const BrowserFileRecord* record = handle.get();
    if (
        !record ||
        !record->belongs_to(engine.browser_file_storage)) {
        throw std::runtime_error("Native File handle is absent or stale.");
    }
    return *record;
}

/** File.text(): immediate in AOT, but still bounded and error-reporting. */
[[nodiscard]] inline std::string file_text(
    const Engine& engine,
    const BrowserFileHandle& handle) {
    const BrowserFileRecord& file = browser_file_record(engine, handle);
    return std::string(file.bytes.begin(), file.bytes.end());
}

inline void replace_browser_file(
    Engine& engine,
    BrowserFileHandle& destination,
    pal::SelectedFileSnapshot selected) {
    BrowserFileRecord* current = destination.get();
    if (
        current &&
        destination.unique() &&
        current->belongs_to(engine.browser_file_storage)) {
        current->replace(
            std::move(selected.bytes),
            std::move(selected.display_name));
        return;
    }
    destination = BrowserFileHandle{
        std::make_shared<BrowserFileRecord>(
            std::move(selected.bytes),
            std::move(selected.display_name),
            engine.browser_file_storage)};
}

namespace detail {

[[nodiscard]] inline bool safe_extension(std::string_view extension) {
    if (extension.empty() || extension.size() > 16u) return false;
    return std::all_of(
        extension.begin(),
        extension.end(),
        [](char character) {
            const auto byte = static_cast<unsigned char>(character);
            return
                (byte >= 'a' && byte <= 'z') ||
                (byte >= 'A' && byte <= 'Z') ||
                (byte >= '0' && byte <= '9') ||
                byte == '_' ||
                byte == '-';
        });
}

[[nodiscard]] inline std::string mime_extension(std::string_view mime) {
    if (mime == "application/json" || mime == "text/json") return "json";
    if (mime == "text/plain") return "txt";
    if (mime == "text/csv") return "csv";
    return {};
}

inline void append_extension(
    std::vector<std::string>& extensions,
    std::string extension) {
    extension = string_lower(std::move(extension));
    if (
        std::find(extensions.begin(), extensions.end(), extension) ==
        extensions.end()) {
        extensions.push_back(std::move(extension));
    }
}

inline bool append_mime_extensions(
    std::vector<std::string>& extensions,
    std::string_view mime) {
    const std::string extension = mime_extension(mime);
    if (extension.empty()) return false;
    append_extension(extensions, extension);
    return true;
}

[[nodiscard]] inline std::string mime_label(
    std::string_view mime,
    std::string_view extension) {
    if (
        (mime == "application/json" || mime == "text/json") &&
        extension == "json") {
        return "JSON files";
    }
    if (mime == "text/plain" && extension == "txt") return "Text files";
    if (mime == "text/csv" && extension == "csv") return "CSV files";
    std::string label(extension);
    std::transform(
        label.begin(),
        label.end(),
        label.begin(),
        [](unsigned char character) {
            return static_cast<char>(std::toupper(character));
        });
    return label + " files";
}

[[nodiscard]] inline std::string download_extension(
    const std::string& name) {
    if (
        name.empty() ||
        name.size() > 240u ||
        name == "." ||
        name == ".." ||
        name.find('/') != std::string::npos ||
        name.find('\\') != std::string::npos ||
        name.find('\0') != std::string::npos) {
        throw std::runtime_error(
            "Anchor download must be a safe suggested file name, not a path.");
    }
    for (const char character : name) {
        const auto byte = static_cast<unsigned char>(character);
        if (
            byte < 0x20u ||
            character == '<' ||
            character == '>' ||
            character == ':' ||
            character == '"' ||
            character == '|' ||
            character == '?' ||
            character == '*') {
            throw std::runtime_error(
                "Anchor download contains a character unsafe in a suggested file name.");
        }
    }
    const std::size_t dot = name.find_last_of('.');
    if (dot == std::string::npos || dot + 1u == name.size()) return {};
    std::string extension = name.substr(dot + 1u);
    if (!safe_extension(extension)) return {};
    return string_lower(std::move(extension));
}

[[nodiscard]] inline pal::FileDialogOptions download_options(
    const std::string& name,
    std::string_view mime_type) {
    std::string extension = download_extension(name);
    const std::string inferred = mime_extension(mime_type);
    if (extension.empty()) extension = inferred;
    pal::FileDialogOptions options{
        .title = "Save file",
        .suggested_name = name,
        .filter_name = "All files",
        .filter_pattern = "*.*",
    };
    if (!extension.empty()) {
        options.filter_name =
            mime_label(mime_type, extension) + " (*." + extension + ")";
        options.filter_pattern = "*." + extension;
    }
    return options;
}

[[nodiscard]] inline pal::FileDialogOptions open_options(
    const std::string& accept) {
    std::vector<std::string> extensions;
    std::string first_mime;
    std::size_t begin = 0;
    while (begin <= accept.size()) {
        const std::size_t comma = accept.find(',', begin);
        std::string token = accept.substr(
            begin,
            comma == std::string::npos
                ? std::string::npos
                : comma - begin);
        while (!token.empty() && std::isspace(
                   static_cast<unsigned char>(token.front()))) {
            token.erase(token.begin());
        }
        while (!token.empty() && std::isspace(
                   static_cast<unsigned char>(token.back()))) {
            token.pop_back();
        }
        if (token.empty() && !accept.empty()) {
            throw std::runtime_error(
                "Native file input accept contains an empty entry.");
        }
        if (!token.empty() && token.front() == '.') {
            const std::string extension = token.substr(1u);
            if (!safe_extension(extension)) {
                throw std::runtime_error(
                    "Native file input accept contains an unsafe extension.");
            }
            append_extension(extensions, extension);
        } else if (!token.empty()) {
            const std::string mime = string_lower(std::move(token));
            if (
                mime.find('*') != std::string::npos ||
                mime.find(';') != std::string::npos ||
                mime.find('/') == std::string::npos) {
                throw std::runtime_error(
                    "Native file input accept requires exact MIME types.");
            }
            if (first_mime.empty()) first_mime = mime;
            if (!append_mime_extensions(extensions, mime)) {
                throw std::runtime_error(
                    "Native file input accept contains an unmappable MIME type.");
            }
        }
        if (comma == std::string::npos) break;
        begin = comma + 1u;
    }
    if (extensions.empty() && !accept.empty()) {
        throw std::runtime_error(
            "Native file input accept cannot be mapped to a safe extension.");
    }
    pal::FileDialogOptions options{
        .title = "Open file",
        .suggested_name = "",
        .filter_name = "All files",
        .filter_pattern = "*.*",
    };
    if (!extensions.empty()) {
        options.filter_pattern.clear();
        for (std::size_t index = 0; index < extensions.size(); ++index) {
            if (index != 0u) options.filter_pattern.push_back(';');
            options.filter_pattern += "*." + extensions[index];
        }
        const std::string& first = extensions.front();
        options.filter_name =
            mime_label(first_mime, first) + " (" +
            options.filter_pattern + ")";
    }
    return options;
}

} // namespace detail

#if defined(BBLITE_HAS_UI) && BBLITE_HAS_UI
/** Default action of a retained `<a href=objectUrl download=name>`. */
inline void click_download_anchor(Engine& engine, UiElementHandle handle) {
    ObjectUrlHandle url{};
    std::string download_name;
    std::shared_ptr<const std::vector<std::uint8_t>> bytes;
    std::string mime_type;
    {
        const UiElementRecord& element =
            browser_file_ui_element(engine, handle);
        if (element.tag != "a" || element.download_name.empty()) {
            throw std::runtime_error(
                "Native anchor navigation is unsupported; download requires an object URL and suggested name.");
        }
        url = element.download_url;
        download_name = element.download_name;
        // Hyperlink activation resolves and retains the immutable payload before
        // click() returns: pointer-lock loss may dispatch a callback that revokes
        // this URL or reallocates either registry while the dialog is open.
        const ObjectUrlRecord& payload = object_url_record(engine, url);
        bytes = payload.bytes;
        mime_type = payload.mime_type;
    }
    const pal::FileDialogOptions options = detail::download_options(
        download_name,
        mime_type);
    const std::optional<std::string> path =
        pal::choose_save_file(engine, options);
    if (!path) return;
    // The retained element must still exist and remain the kind whose default
    // action was entered. Its URL may now be revoked; the download already
    // owns the activation-time byte snapshot, matching immediate revocation.
    const UiElementRecord& element =
        browser_file_ui_element(engine, handle);
    if (element.tag != "a") {
        throw std::runtime_error(
            "Native download anchor changed type while its dialog was open.");
    }
    if (!bytes) {
        throw std::runtime_error(
            "Native download object URL has no payload.");
    }
    pal::write_selected_file_atomically(*path, *bytes);
}

/** Default action of a retained `<input type=file>`. */
inline void click_file_input(Engine& engine, UiElementHandle handle) {
    pal::FileDialogOptions options;
    {
        const UiElementRecord& element =
            browser_file_ui_element(engine, handle);
        if (element.tag != "input" || !element.file_input) {
            throw std::runtime_error(
                "Native input click requires static type='file'.");
        }
        options = detail::open_options(element.file_accept);
    }
    std::optional<pal::SelectedFileSnapshot> selected =
        pal::choose_open_file(engine, options);
    // Cancel changes neither the previous FileList nor its event sequence.
    if (!selected) return;
    std::vector<std::function<void()>> callbacks;
    {
        const UiElementRecord& element =
            browser_file_ui_element(engine, handle);
        if (element.tag != "input" || !element.file_input) {
            throw std::runtime_error(
                "Native file input changed type while its dialog was open.");
        }
        callbacks = element.file_change_callbacks;
    }
    replace_browser_file(
        engine,
        browser_file_ui_element(engine, handle).selected_file,
        std::move(*selected));
    for (const auto& callback : callbacks) callback();
}
#endif

} // namespace bbl::js
