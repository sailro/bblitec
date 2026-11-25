#pragma once

// The bounded JavaScript File API slice reached by generated applications.
// Blob and opaque handles live here; dialogs, selected-path reads, and atomic
// writes stay behind pal.hpp. No source-supplied path enters this interface.

#include <bblite/features/has_ui.hpp>

#include <bblite/js_blob.hpp>
#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>
#include <bblite/js_json.hpp>
#include <bblite/js_promise.hpp>
#include <bblite/js_structured_clone.hpp>
#include <bblite/pal.hpp>
#include <bblite/pal_dom_events.hpp>
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::js {

inline constexpr std::size_t maximum_object_urls = 4096u;

[[nodiscard]] inline ObjectUrlRecord& object_url_record(Engine& engine, ObjectUrlHandle handle) {
    if (handle.slot >= engine.object_urls.size()) {
        throw std::runtime_error("Native object URL is unknown or has been revoked.");
    }
    ObjectUrlRecord& record = engine.object_urls[handle.slot];
    if (!record.active || handle.generation == 0 || record.generation != handle.generation) {
        throw std::runtime_error("Native object URL is unknown or has been revoked.");
    }
    return record;
}

/** Each call mints a distinct URL identity, even for the same Blob value. */
[[nodiscard]] inline ObjectUrlHandle create_object_url(Engine& engine, const Blob& blob) {
    const auto& bytes = blob.payload();
    std::string mime_type = blob.type();
    std::uint32_t slot = invalid_handle;
    if (!engine.free_object_url_slots.empty()) {
        slot = engine.free_object_url_slots.back();
        engine.free_object_url_slots.pop_back();
    } else {
        if (engine.object_urls.size() >= maximum_object_urls) {
            throw std::runtime_error("Native object URL registry exceeds its 4096-entry bound.");
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

/** An object URL's payload, which a revoked or payload-less URL does not have. */
[[nodiscard]] inline std::shared_ptr<const std::vector<std::uint8_t>>
object_url_bytes(Engine& engine, ObjectUrlHandle url) {
    const ObjectUrlRecord& record = object_url_record(engine, url);
    if (!record.bytes)
        throw std::runtime_error("Native object URL has no payload.");
    return record.bytes;
}

/** An object URL as a string: the `blob:` key naming its handle, which each `createObjectURL` mints anew. */
[[nodiscard]] inline std::string object_url_string(ObjectUrlHandle url) {
    return "blob:" + std::to_string(url.slot) + ":" + std::to_string(url.generation);
}

/**
 * `loadTexture2D` of an object URL: the image is the URL's payload, and the
 * pin's cache keys it by the URL.
 */
[[nodiscard]] inline TextureImageSource object_url_image(Engine& engine, ObjectUrlHandle url) {
    return {object_url_string(url), object_url_bytes(engine, url)};
}

/**
 * `loadKtx2Texture2D` of an object URL. The pin transcodes the bytes it
 * fetches; generation transcoded every KTX2 image the program's packaged
 * bytes hold, and the URL's payload selects its chain by content.
 */
[[nodiscard]] inline std::string object_url_ktx2_path(Engine& engine, ObjectUrlHandle url) {
    std::string path = packaged_content_path(*object_url_bytes(engine, url), ".ktx");
    if (!pal::is_file(path))
        throw std::runtime_error(
            "KTX2: an object URL's bytes are no KTX2 image packaged with this program.");
    return path;
}

/**
 * Browser revocation is idempotent. A stale generation is ignored, while a
 * later use of that token is rejected by object_url_record.
 */
inline void revoke_object_url(Engine& engine, ObjectUrlHandle handle) {
    if (handle.slot >= engine.object_urls.size())
        return;
    ObjectUrlRecord& record = engine.object_urls[handle.slot];
    if (!record.active || record.generation != handle.generation)
        return;
    record.active = false;
    record.bytes.reset();
    record.mime_type.clear();
    if (has_next_generation(record.generation)) {
        ++record.generation;
        engine.free_object_url_slots.push_back(handle.slot);
    }
}

/**
 * `revokeObjectURL` of a URL string: one `object_url_string` wrote names
 * the URL it revokes; the browser ignores any other string, and so does this.
 */
inline void revoke_object_url(Engine& engine, std::string_view url) {
    constexpr std::string_view scheme = "blob:";
    if (!url.starts_with(scheme))
        return;
    const std::string_view rest = url.substr(scheme.size());
    const std::size_t colon = rest.find(':');
    if (colon == std::string_view::npos)
        return;
    std::uint32_t slot = 0;
    std::uint32_t generation = 0;
    const std::string_view slot_text = rest.substr(0, colon);
    const std::string_view generation_text = rest.substr(colon + 1);
    const auto parsed_slot =
        std::from_chars(slot_text.data(), slot_text.data() + slot_text.size(), slot);
    const auto parsed_generation = std::from_chars(
        generation_text.data(), generation_text.data() + generation_text.size(), generation);
    if (parsed_slot.ec != std::errc{} || parsed_slot.ptr != slot_text.data() + slot_text.size() ||
        parsed_generation.ec != std::errc{} ||
        parsed_generation.ptr != generation_text.data() + generation_text.size())
        return;
    revoke_object_url(engine, ObjectUrlHandle{slot, generation});
}

/** One immutable snapshot of selected or dropped files; a program reads the first. */
struct FileList {
    FileList() = default;
    explicit FileList(BrowserFileHandle selected, std::size_t selected_count = 1)
        : first(std::move(selected)), count(selected_count) {}
    BrowserFileHandle first{};
    /** How many files a drop carried; a selection holds one. */
    std::size_t count = 1;

    [[nodiscard]] std::size_t length() const noexcept { return first ? count : 0u; }
    [[nodiscard]] const void* get() const noexcept { return identity_.get(); }
    explicit operator bool() const noexcept { return true; }
    [[nodiscard]] bool operator==(const FileList& other) const noexcept {
        return identity_ == other.identity_;
    }

private:
    std::shared_ptr<const unsigned char> identity_ = std::make_shared<const unsigned char>(0);
};

#if BBLITE_HAS_UI
[[nodiscard]] inline UiElementRecord& browser_file_ui_element(Engine& engine,
                                                              UiElementHandle handle) {
    return handle_at(engine.ui_elements, handle);
}

[[nodiscard]] inline FileList input_files(Engine& engine, UiElementHandle input) {
    const UiElementRecord& element = browser_file_ui_element(engine, input);
    if (element.tag != "input" || !element.file_input) {
        throw std::runtime_error("Native files list requires an <input type=\"file\">.");
    }
    return FileList{element.selected_file};
}
#endif

[[nodiscard]] inline BrowserFileHandle file_at(const FileList& files, std::size_t index) {
    return index == 0u ? files.first : BrowserFileHandle{};
}

/** An indexed missing file is undefined; selected handles own their immutable bytes. */
[[nodiscard]] inline Nullable<BrowserFileHandle> optional_file(BrowserFileHandle file) {
    return file ? Nullable<BrowserFileHandle>{std::move(file)} : Nullable<BrowserFileHandle>{};
}

[[nodiscard]] inline const BrowserFileRecord& browser_file_record(const BrowserFileHandle& handle) {
    if (!handle)
        throw std::runtime_error("Native File handle is absent.");
    return *handle.get();
}

[[nodiscard]] inline std::string file_name(const BrowserFileHandle& handle) {
    return browser_file_record(handle).display_name;
}

[[nodiscard]] inline double file_size(const BrowserFileHandle& handle) {
    return static_cast<double>(browser_file_record(handle).bytes.size());
}

[[nodiscard]] inline std::string_view file_bytes(const BrowserFileHandle& handle) {
    const BrowserFileRecord& file = browser_file_record(handle);
    return {reinterpret_cast<const char*>(file.bytes.data()), file.bytes.size()};
}

[[nodiscard]] inline std::string file_text(const BrowserFileHandle& handle) {
    return decode_utf8_removing_bom(file_bytes(handle));
}

/** File.arrayBuffer(): a fresh buffer holding the snapshot's bytes, as read. */
[[nodiscard]] inline ArrayBuffer file_array_buffer(const BrowserFileHandle& handle) {
    const std::vector<std::uint8_t>& bytes = browser_file_record(handle).bytes;
    return ArrayBuffer(std::vector<std::uint8_t>(bytes.begin(), bytes.end()));
}

[[nodiscard]] inline const BrowserFileRecord& browser_file_record(const Engine& engine,
                                                                  const BrowserFileHandle& handle) {
    const BrowserFileRecord* record = handle.get();
    if (!record || !record->belongs_to(engine.browser_file_storage)) {
        throw std::runtime_error("Native File handle is absent or stale.");
    }
    return *record;
}

/** File.name: the selected or dropped file's display name. */
[[nodiscard]] inline std::string file_name(const Engine& engine, const BrowserFileHandle& handle) {
    return browser_file_record(engine, handle).display_name;
}

/** File.size: the snapshot's byte length. */
[[nodiscard]] inline double file_size(const Engine& engine, const BrowserFileHandle& handle) {
    return static_cast<double>(browser_file_record(engine, handle).bytes.size());
}

/** A selected File's bytes, as the snapshot holds them. */
[[nodiscard]] inline std::string_view file_bytes(const Engine& engine,
                                                 const BrowserFileHandle& handle) {
    const BrowserFileRecord& file = browser_file_record(engine, handle);
    return {reinterpret_cast<const char*>(file.bytes.data()), file.bytes.size()};
}

/**
 * File.text(): immediate in AOT, but still bounded and error-reporting. The
 * bytes are UTF-8 decoded as Blob.text() does: a byte order mark is removed
 * and an invalid sequence reads as U+FFFD.
 */
[[nodiscard]] inline std::string file_text(const Engine& engine, const BrowserFileHandle& handle) {
    return decode_utf8_removing_bom(file_bytes(engine, handle));
}

/**
 * `FileReader` over a File or Blob, reading as text. The read completes
 * inside `readAsText`: the bytes are decoded as the Encoding Standard does
 * without a label and `load` runs before the call returns, or `error` when
 * the file can no longer be read. The compiler admits the handlers only
 * when they are assigned before the read starts.
 */
class FileReader {
    struct State {
        Nullable<std::string> result;
        Callback<void()> onload;
        Callback<void()> onerror;
        void gc_trace(const TraceVisitor& visitor) const {
            visitor(onload);
            visitor(onerror);
        }
    };

public:
    void set_onload(Callback<void()> handler) const { state_->onload = std::move(handler); }
    void set_onerror(Callback<void()> handler) const { state_->onerror = std::move(handler); }
    [[nodiscard]] Nullable<std::string> result() const { return state_->result; }

    void read_as_text(const Engine& engine, const BrowserFileHandle& file) const {
        std::optional<std::string_view> bytes;
        try {
            bytes = file_bytes(engine, file);
        } catch (const std::runtime_error&) {
            bytes.reset();
        }
        settle(bytes);
    }
    void read_as_text(const BrowserFileHandle& file) const {
        settle(file ? std::optional<std::string_view>(file_bytes(file)) : std::nullopt);
    }
    void read_as_text(const Blob& blob) const {
        const auto& bytes = blob.bytes();
        settle(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
    }

    void gc_trace(const TraceVisitor& visitor) const { visitor(state_); }

private:
    void settle(std::optional<std::string_view> bytes) const {
        state_->result = bytes ? Nullable<std::string>(decode_text(*bytes))
                               : Nullable<std::string>(std::nullopt);
        // A handler may replace the reader's handlers; run the one this
        // read selected.
        Callback<void()> handler = bytes ? state_->onload : state_->onerror;
        if (handler)
            handler();
    }

    std::shared_ptr<State> state_ = make_gc_shared<State>();
};

inline void replace_browser_file(Engine& engine, BrowserFileHandle& destination,
                                 pal::SelectedFileSnapshot selected) {
    if (!engine.browser_file_storage)
        engine.browser_file_storage = std::make_shared<BrowserFileStorage>();
    BrowserFileRecord* current = destination.get();
    if (current && destination.unique() && current->belongs_to(engine.browser_file_storage)) {
        current->replace(std::move(selected.bytes), std::move(selected.display_name));
        return;
    }
    destination = BrowserFileHandle{std::make_shared<BrowserFileRecord>(
        std::move(selected.bytes), std::move(selected.display_name), engine.browser_file_storage)};
}

/** A drop's files: the first becomes a File of the owning realm on first read. */
[[nodiscard]] inline FileList drag_files(Engine& engine, const PlatformDragEvent& event) {
    if (!event.files || event.files->count == 0)
        return {};
    if (!event.first_file) {
        const auto& file = *event.files;
        replace_browser_file(engine, event.first_file,
                             pal::SelectedFileSnapshot{file.bytes, file.name});
    }
    return FileList{event.first_file, event.files->count};
}

namespace detail {

struct FileTypeDescriptor {
    std::string_view mime;
    std::string_view extension;
    std::string_view label;
};

inline constexpr FileTypeDescriptor file_types[]{
#define BBLITE_FILE_TYPE(mime, extension, label) {mime, extension, label},
#include <bblite/file_types.inc>
#undef BBLITE_FILE_TYPE
};

[[nodiscard]] inline bool safe_extension(std::string_view extension) {
    if (extension.empty() || extension.size() > 16u)
        return false;
    return std::all_of(extension.begin(), extension.end(), [](char character) {
        const auto byte = static_cast<unsigned char>(character);
        return (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
               (byte >= '0' && byte <= '9') || byte == '_' || byte == '-';
    });
}

[[nodiscard]] inline std::string mime_extension(std::string_view mime) {
    for (const FileTypeDescriptor& type : file_types) {
        if (mime == type.mime)
            return std::string(type.extension);
    }
    return {};
}

inline void append_extension(std::vector<std::string>& extensions, std::string extension) {
    extension = string_lower(std::move(extension));
    if (std::find(extensions.begin(), extensions.end(), extension) == extensions.end()) {
        extensions.push_back(std::move(extension));
    }
}

/** A wildcard accept entry: every type under one top-level media type. */
[[nodiscard]] inline bool mime_wildcard(std::string_view mime) {
    return mime.size() > 2u && mime.ends_with("/*") && mime.find('*') == mime.size() - 1u;
}

/** The extensions of every file type an exact or wildcard MIME entry names. */
inline bool append_mime_extensions(std::vector<std::string>& extensions, std::string_view mime) {
    bool mapped = false;
    const bool wildcard = mime_wildcard(mime);
    for (const FileTypeDescriptor& type : file_types) {
        if (wildcard ? type.mime.starts_with(mime.substr(0, mime.size() - 1u))
                     : type.mime == mime) {
            append_extension(extensions, std::string(type.extension));
            mapped = true;
        }
    }
    return mapped;
}

[[nodiscard]] inline std::string mime_label(std::string_view mime, std::string_view extension) {
    if (mime_wildcard(mime)) {
        std::string label(mime.substr(0, mime.find('/')));
        label.front() = static_cast<char>(std::toupper(static_cast<unsigned char>(label.front())));
        return label + " files";
    }
    for (const FileTypeDescriptor& type : file_types) {
        if (mime == type.mime && extension == type.extension)
            return std::string(type.label);
    }
    std::string label(extension);
    std::transform(label.begin(), label.end(), label.begin(), [](unsigned char character) {
        return static_cast<char>(std::toupper(character));
    });
    return label + " files";
}

[[nodiscard]] inline std::string download_extension(const std::string& name) {
    if (name.empty() || name.size() > 240u || name == "." || name == ".." ||
        name.find('/') != std::string::npos || name.find('\\') != std::string::npos ||
        name.find('\0') != std::string::npos) {
        throw std::runtime_error("Anchor download must be a safe suggested file name, not a path.");
    }
    for (const char character : name) {
        const auto byte = static_cast<unsigned char>(character);
        if (byte < 0x20u || character == '<' || character == '>' || character == ':' ||
            character == '"' || character == '|' || character == '?' || character == '*') {
            throw std::runtime_error(
                "Anchor download contains a character unsafe in a suggested file name.");
        }
    }
    const std::size_t dot = name.find_last_of('.');
    if (dot == std::string::npos || dot + 1u == name.size())
        return {};
    std::string extension = name.substr(dot + 1u);
    if (!safe_extension(extension))
        return {};
    return string_lower(std::move(extension));
}

[[nodiscard]] inline pal::FileDialogOptions download_options(const std::string& name,
                                                             std::string_view mime_type) {
    std::string extension = download_extension(name);
    const std::string inferred = mime_extension(mime_type);
    if (extension.empty())
        extension = inferred;
    pal::FileDialogOptions options{
        .title = "Save file",
        .suggested_name = name,
        .filter_name = "All files",
        .filter_pattern = "*.*",
    };
    if (!extension.empty()) {
        options.filter_name = mime_label(mime_type, extension) + " (*." + extension + ")";
        options.filter_pattern = "*." + extension;
    }
    return options;
}

[[nodiscard]] inline pal::FileDialogOptions open_options(const std::string& accept) {
    std::vector<std::string> extensions;
    std::string first_mime;
    std::size_t begin = 0;
    while (begin <= accept.size()) {
        const std::size_t comma = accept.find(',', begin);
        std::string token =
            accept.substr(begin, comma == std::string::npos ? std::string::npos : comma - begin);
        while (!token.empty() && std::isspace(static_cast<unsigned char>(token.front()))) {
            token.erase(token.begin());
        }
        while (!token.empty() && std::isspace(static_cast<unsigned char>(token.back()))) {
            token.pop_back();
        }
        if (token.empty() && !accept.empty()) {
            throw std::runtime_error("Native file input accept contains an empty entry.");
        }
        if (!token.empty() && token.front() == '.') {
            const std::string extension = token.substr(1u);
            if (!safe_extension(extension)) {
                throw std::runtime_error("Native file input accept contains an unsafe extension.");
            }
            append_extension(extensions, extension);
        } else if (!token.empty()) {
            const std::string mime = string_lower(std::move(token));
            if ((mime.find('*') != std::string::npos && !mime_wildcard(mime)) ||
                mime.find(';') != std::string::npos || mime.find('/') == std::string::npos) {
                throw std::runtime_error(
                    "Native file input accept requires exact MIME types or a type/* wildcard.");
            }
            if (first_mime.empty())
                first_mime = mime;
            if (!append_mime_extensions(extensions, mime)) {
                throw std::runtime_error(
                    "Native file input accept contains an unmappable MIME type.");
            }
        }
        if (comma == std::string::npos)
            break;
        begin = comma + 1u;
    }
    if (extensions.empty() && !accept.empty()) {
        throw std::runtime_error("Native file input accept cannot be mapped to a safe extension.");
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
            if (index != 0u)
                options.filter_pattern.push_back(';');
            options.filter_pattern += "*." + extensions[index];
        }
        const std::string& first = extensions.front();
        options.filter_name = mime_label(first_mime, first) + " (" + options.filter_pattern + ")";
    }
    return options;
}

} // namespace detail

#if BBLITE_HAS_UI
/** Default action of a retained `<a href=objectUrl download=name>`. */
inline void click_download_anchor(Engine& engine, UiElementHandle handle) {
    ObjectUrlHandle url{};
    std::string download_name;
    std::shared_ptr<const std::vector<std::uint8_t>> bytes;
    std::string mime_type;
    {
        const UiElementRecord& element = browser_file_ui_element(engine, handle);
        if (element.tag != "a" || element.download_name.empty()) {
            throw std::runtime_error(
                "A native download anchor requires an object URL and a suggested name.");
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
    const pal::FileDialogOptions options = detail::download_options(download_name, mime_type);
    if (!bytes) {
        throw std::runtime_error("Native download object URL has no payload.");
    }
    pal::save_file(engine, options, *bytes, [&engine, handle] {
        // Pointer-lock loss may revoke the URL or change the retained element.
        // The bytes remain the activation-time snapshot.
        if (browser_file_ui_element(engine, handle).tag != "a") {
            throw std::runtime_error(
                "Native download anchor changed type while its dialog was open.");
        }
    });
}

/** Default action of a retained `<input type=file>`. */
inline void click_file_input(Engine& engine, UiElementHandle handle) {
    pal::FileDialogOptions options;
    {
        const UiElementRecord& element = browser_file_ui_element(engine, handle);
        if (element.tag != "input" || !element.file_input) {
            throw std::runtime_error("Native input click requires static type='file'.");
        }
        options = detail::open_options(element.file_accept);
    }
    std::optional<pal::SelectedFileSnapshot> selected = pal::choose_open_file(engine, options);
    const auto dispatchEvent = [&engine, handle](const char* type) {
        PlatformMouseEvent payload;
        payload.payload_kind = DomInputEventKind::Event;
        const auto event = dom_event(payload, type, dom_ui_path(engine, handle), true, false);
        event.dom->composed = std::string_view(type) == "input";
        dispatch_dom_pointer(engine, event);
    };
    // Cancellation preserves the previous selection and notifies its listener.
    if (!selected) {
        if (engine.dom_input)
            dispatchEvent("cancel");
        return;
    }
    std::shared_ptr<UiEventListeners> listeners;
    {
        const UiElementRecord& element = browser_file_ui_element(engine, handle);
        if (element.tag != "input" || !element.file_input) {
            throw std::runtime_error("Native file input changed type while its dialog was open.");
        }
        listeners = element.file_change_callbacks;
    }
    replace_browser_file(engine, browser_file_ui_element(engine, handle).selected_file,
                         std::move(*selected));
    if (engine.dom_input) {
        for (const char* type : {"input", "change"})
            dispatchEvent(type);
    }
    if (listeners)
        listeners->dispatch(PlatformMouseEvent{});
}

/** File default actions run on the element's owner, including a Window-forwarded click. */
inline void activate_file_element(Engine& engine, UiElementHandle handle) {
    const auto& element = browser_file_ui_element(engine, handle);
    if (element.tag == "a" && !element.download_name.empty())
        click_download_anchor(engine, handle);
    else if (element.tag == "input" && element.file_input)
        click_file_input(engine, handle);
}
#endif

/** `blob.text()`: UTF-8 decoding with replacement, without a leading BOM. */
[[nodiscard]] inline Promise<std::string> blob_text(const Blob& blob) {
    return Promise<std::string>::resolved(decode_utf8_removing_bom(
        std::string_view(reinterpret_cast<const char*>(blob.bytes().data()), blob.size())));
}

/** `blob.arrayBuffer()`: a fresh buffer over a copy of the bytes. */
[[nodiscard]] inline Promise<ArrayBuffer> blob_array_buffer(const Blob& blob) {
    return Promise<ArrayBuffer>::resolved(ArrayBuffer(std::vector<std::uint8_t>(blob.bytes())));
}

/** `blob.bytes()`: a fresh Uint8Array over a copy of the bytes. */
[[nodiscard]] inline Promise<U8Array> blob_bytes(const Blob& blob) {
    return Promise<U8Array>::resolved(
        U8Array(ArrayBuffer(std::vector<std::uint8_t>(blob.bytes()))));
}

} // namespace bbl::js
