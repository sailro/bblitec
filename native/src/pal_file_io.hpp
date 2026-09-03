#pragma once

// PAL-only bounded file helpers shared by Web Storage, the legacy voxel
// picker, and the generic browser file bridge. Paths reach this file only
// after a PAL service selected or constructed them.

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <limits>
#include <random>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#if defined(_WIN32)
#include "pal_win32_text.hpp"
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace bbl::pal::detail {

#if defined(_WIN32)
class UniqueFileHandle {
  public:
    UniqueFileHandle() = default;
    explicit UniqueFileHandle(HANDLE handle) : handle_(handle) {}
    UniqueFileHandle(const UniqueFileHandle&) = delete;
    UniqueFileHandle& operator=(const UniqueFileHandle&) = delete;
    ~UniqueFileHandle() {
        if (handle_ != INVALID_HANDLE_VALUE) {
            static_cast<void>(CloseHandle(handle_));
        }
    }

    [[nodiscard]] HANDLE get() const { return handle_; }
    [[nodiscard]] bool valid() const {
        return handle_ != INVALID_HANDLE_VALUE;
    }
    void reset(HANDLE handle) {
        if (handle_ != INVALID_HANDLE_VALUE) {
            static_cast<void>(CloseHandle(handle_));
        }
        handle_ = handle;
    }
    [[nodiscard]] BOOL close() {
        if (handle_ == INVALID_HANDLE_VALUE) return TRUE;
        const HANDLE handle = handle_;
        handle_ = INVALID_HANDLE_VALUE;
        return CloseHandle(handle);
    }

  private:
    HANDLE handle_ = INVALID_HANDLE_VALUE;
};
#else
class UniqueFileDescriptor {
  public:
    UniqueFileDescriptor() = default;
    explicit UniqueFileDescriptor(int descriptor) : descriptor_(descriptor) {}
    UniqueFileDescriptor(const UniqueFileDescriptor&) = delete;
    UniqueFileDescriptor& operator=(const UniqueFileDescriptor&) = delete;
    ~UniqueFileDescriptor() {
        if (descriptor_ >= 0) static_cast<void>(::close(descriptor_));
    }

    [[nodiscard]] int get() const { return descriptor_; }
    [[nodiscard]] bool valid() const { return descriptor_ >= 0; }
    void reset(int descriptor) {
        if (descriptor_ >= 0) static_cast<void>(::close(descriptor_));
        descriptor_ = descriptor;
    }
    [[nodiscard]] int close() {
        if (descriptor_ < 0) return 0;
        const int descriptor = descriptor_;
        descriptor_ = -1;
        return ::close(descriptor);
    }

  private:
    int descriptor_ = -1;
};
#endif

[[nodiscard]] inline std::filesystem::path utf8_file_path(
    std::string_view value) {
    return std::filesystem::path{
        std::u8string(value.begin(), value.end())};
}

[[nodiscard]] inline std::vector<std::uint8_t> read_binary_file_bounded(
    const std::filesystem::path& path,
    std::uintmax_t maximum_bytes,
    std::string_view description) {
#if defined(_WIN32)
    UniqueFileHandle handle(CreateFileW(
        path.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL |
            FILE_FLAG_OPEN_REPARSE_POINT |
            FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr));
    if (!handle.valid()) {
        throw std::runtime_error(
            "Unable to inspect " + std::string(description) + ": " +
            "Win32 error " + std::to_string(GetLastError()) + ".");
    }
    BY_HANDLE_FILE_INFORMATION information{};
    LARGE_INTEGER size{};
    if (
        !GetFileInformationByHandle(handle.get(), &information) ||
        !GetFileSizeEx(handle.get(), &size)) {
        const DWORD error = GetLastError();
        throw std::runtime_error(
            "Unable to inspect " + std::string(description) +
            " (Win32 error " + std::to_string(error) + ").");
    }
    if (
        (information.dwFileAttributes &
            (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        size.QuadPart < 0) {
        throw std::runtime_error(
            std::string(description) +
            " must be a regular file, not a directory or reparse point.");
    }
    const auto unsigned_size =
        static_cast<unsigned long long>(size.QuadPart);
    if (
        unsigned_size > maximum_bytes ||
        unsigned_size >
            static_cast<unsigned long long>(
                (std::numeric_limits<std::size_t>::max)())) {
        throw std::runtime_error(
            std::string(description) + " exceeds the native read bound.");
    }
    std::vector<std::uint8_t> value(
        static_cast<std::size_t>(unsigned_size));
    std::size_t offset = 0;
    while (offset < value.size()) {
        const DWORD request = static_cast<DWORD>(
            (std::min)(
                value.size() - offset,
                static_cast<std::size_t>(
                    (std::numeric_limits<DWORD>::max)())));
        DWORD received = 0;
        if (
            !ReadFile(
                handle.get(),
                value.data() + offset,
                request,
                &received,
                nullptr) ||
            received == 0) {
            const DWORD error = GetLastError();
            throw std::runtime_error(
                "Reading " + std::string(description) +
                " failed (Win32 error " + std::to_string(error) + ").");
        }
        offset += received;
    }
    std::uint8_t trailing = 0;
    DWORD trailing_size = 0;
    if (
        !ReadFile(handle.get(), &trailing, 1, &trailing_size, nullptr) ||
        trailing_size != 0) {
        const DWORD error = GetLastError();
        throw std::runtime_error(
            std::string(description) +
            " changed while it was read or exceeds the native read bound" +
            (error == ERROR_SUCCESS
                 ? std::string(".")
                 : " (Win32 error " + std::to_string(error) + ")."));
    }
    return value;
#else
#if !defined(O_NOFOLLOW)
#error "Browser file IO requires O_NOFOLLOW on this host."
#endif
    int flags = O_RDONLY | O_NOFOLLOW;
#if defined(O_CLOEXEC)
    flags |= O_CLOEXEC;
#endif
    UniqueFileDescriptor descriptor(::open(path.c_str(), flags));
    if (!descriptor.valid()) {
        throw std::runtime_error(
            "Unable to inspect " + std::string(description) + ": " +
            std::error_code(errno, std::generic_category()).message() + ".");
    }
    struct stat information {};
    if (::fstat(descriptor.get(), &information) != 0) {
        const int error = errno;
        throw std::runtime_error(
            "Unable to inspect " + std::string(description) + ": " +
            std::error_code(error, std::generic_category()).message() + ".");
    }
    if (!S_ISREG(information.st_mode) || information.st_size < 0) {
        throw std::runtime_error(
            std::string(description) + " must be a regular file.");
    }
    const auto size = static_cast<std::uintmax_t>(information.st_size);
    if (
        size > maximum_bytes ||
        size > (std::numeric_limits<std::size_t>::max)()) {
        throw std::runtime_error(
            std::string(description) + " exceeds the native read bound.");
    }
    std::vector<std::uint8_t> value(static_cast<std::size_t>(size));
    std::size_t offset = 0;
    while (offset < value.size()) {
        const ssize_t received = ::read(
            descriptor.get(),
            value.data() + offset,
            value.size() - offset);
        if (received < 0 && errno == EINTR) continue;
        if (received <= 0) {
            const int error = errno;
            throw std::runtime_error(
                "Reading " + std::string(description) + " failed: " +
                std::error_code(error, std::generic_category()).message() +
                ".");
        }
        offset += static_cast<std::size_t>(received);
    }
    std::uint8_t trailing = 0;
    ssize_t trailing_size = -1;
    do {
        trailing_size = ::read(descriptor.get(), &trailing, 1);
    } while (trailing_size < 0 && errno == EINTR);
    if (trailing_size != 0) {
        const int error = errno;
        throw std::runtime_error(
            std::string(description) +
            " changed while it was read or exceeds the native read bound" +
            (trailing_size < 0
                 ? ": " +
                       std::error_code(error, std::generic_category()).message() +
                       "."
                 : "."));
    }
    return value;
#endif
}

[[nodiscard]] inline std::string read_text_file_bounded(
    const std::filesystem::path& path,
    std::uintmax_t maximum_bytes,
    std::string_view description) {
    const std::vector<std::uint8_t> bytes =
        read_binary_file_bounded(path, maximum_bytes, description);
    if (bytes.empty()) return {};
    return std::string(
        reinterpret_cast<const char*>(bytes.data()),
        bytes.size());
}

[[nodiscard]] inline std::string random_staging_token() {
    static constexpr char hex[] = "0123456789abcdef";
    std::random_device entropy;
    std::uniform_int_distribution<unsigned int> octet(0u, 255u);
    std::string token;
    token.reserve(32u);
    for (std::size_t index = 0; index < 16u; ++index) {
        const unsigned int value = octet(entropy);
        token.push_back(hex[(value >> 4u) & 0x0fu]);
        token.push_back(hex[value & 0x0fu]);
    }
    return token;
}

[[nodiscard]] inline std::filesystem::path random_staging_path(
    const std::filesystem::path& destination) {
    return destination.parent_path() /
        (".bblite-write-" + random_staging_token() + ".tmp");
}

inline void validate_staging_path(
    const std::filesystem::path& destination,
    const std::filesystem::path& staging) {
    if (
        staging == destination ||
        staging.filename().empty() ||
        staging.parent_path() != destination.parent_path()) {
        throw std::runtime_error(
            "Atomic-write staging must stay in the destination directory.");
    }
}

inline void replace_file(
    const std::filesystem::path& staging,
    const std::filesystem::path& destination) {
#if defined(_WIN32)
    const std::wstring staging_wide = staging.wstring();
    const std::wstring destination_wide = destination.wstring();
    if (!MoveFileExW(
            staging_wide.c_str(),
            destination_wide.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        throw std::runtime_error(
            "Unable to commit atomic file write (Win32 error " +
            std::to_string(GetLastError()) + ").");
    }
#else
    std::error_code error;
    std::filesystem::rename(staging, destination, error);
    if (error) {
        throw std::runtime_error(
            "Unable to commit atomic file write: " + error.message() + ".");
    }
#endif
}

template <typename NextStagingPath>
inline void write_file_atomically_with_staging_paths(
    const std::filesystem::path& destination,
    std::span<const std::uint8_t> bytes,
    std::size_t maximum_bytes,
    std::string_view description,
    NextStagingPath&& next_staging_path) {
    if (bytes.size() > maximum_bytes) {
        throw std::runtime_error(
            std::string(description) + " exceeds the native write bound.");
    }
    std::filesystem::path staging;
#if defined(_WIN32)
    UniqueFileHandle handle;
    for (std::size_t attempt = 0; attempt < 128u; ++attempt) {
        staging = next_staging_path(destination, attempt);
        validate_staging_path(destination, staging);
        const HANDLE candidate = CreateFileW(
            staging.c_str(),
            GENERIC_WRITE,
            0,
            nullptr,
            CREATE_NEW,
            FILE_ATTRIBUTE_TEMPORARY |
                FILE_FLAG_OPEN_REPARSE_POINT |
                FILE_FLAG_WRITE_THROUGH,
            nullptr);
        if (candidate != INVALID_HANDLE_VALUE) {
                handle.reset(candidate);
                break;
        }
        const DWORD error = GetLastError();
        if (
            error != ERROR_FILE_EXISTS &&
            error != ERROR_ALREADY_EXISTS) {
            throw std::runtime_error(
                "Unable to create an exclusive atomic-write staging file " +
                std::string("(Win32 error ") + std::to_string(error) + ").");
        }
    }
    if (!handle.valid()) {
        throw std::runtime_error(
            "Unable to allocate a randomized atomic-write staging file.");
    }
    try {
        std::size_t offset = 0;
        while (offset < bytes.size()) {
            const DWORD request = static_cast<DWORD>(
                (std::min)(
                    bytes.size() - offset,
                    static_cast<std::size_t>(
                        (std::numeric_limits<DWORD>::max)())));
            DWORD written_size = 0;
            if (
                !WriteFile(
                    handle.get(),
                    bytes.data() + offset,
                    request,
                    &written_size,
                    nullptr) ||
                written_size == 0) {
                throw std::runtime_error(
                    "Writing " + std::string(description) +
                    " failed (Win32 error " +
                    std::to_string(GetLastError()) + ").");
            }
            offset += written_size;
        }
        if (!FlushFileBuffers(handle.get())) {
            throw std::runtime_error(
                "Flushing " + std::string(description) +
                " failed (Win32 error " +
                std::to_string(GetLastError()) + ").");
        }
        if (!handle.close()) {
            const DWORD error = GetLastError();
            throw std::runtime_error(
                "Closing " + std::string(description) +
                " failed (Win32 error " +
                std::to_string(error) + ").");
        }
        replace_file(staging, destination);
    } catch (...) {
        std::error_code discard;
        std::filesystem::remove(staging, discard);
        throw;
    }
#else
#if !defined(O_NOFOLLOW)
#error "Atomic file IO requires O_NOFOLLOW on this host."
#endif
    UniqueFileDescriptor descriptor;
    for (std::size_t attempt = 0; attempt < 128u; ++attempt) {
        staging = next_staging_path(destination, attempt);
        validate_staging_path(destination, staging);
        int flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
#if defined(O_CLOEXEC)
        flags |= O_CLOEXEC;
#endif
        const int candidate = ::open(staging.c_str(), flags, 0600);
        if (candidate >= 0) {
            descriptor.reset(candidate);
            break;
        }
        if (errno != EEXIST) {
            throw std::runtime_error(
                "Unable to create an exclusive atomic-write staging file: " +
                std::error_code(errno, std::generic_category()).message() +
                ".");
        }
    }
    if (!descriptor.valid()) {
        throw std::runtime_error(
            "Unable to allocate a randomized atomic-write staging file.");
    }
    try {
        std::size_t offset = 0;
        while (offset < bytes.size()) {
            const ssize_t written_size = ::write(
                descriptor.get(),
                bytes.data() + offset,
                bytes.size() - offset);
            if (written_size < 0 && errno == EINTR) continue;
            if (written_size <= 0) {
                throw std::runtime_error(
                    "Writing " + std::string(description) + " failed: " +
                    std::error_code(errno, std::generic_category()).message() +
                    ".");
            }
            offset += static_cast<std::size_t>(written_size);
        }
        if (::fsync(descriptor.get()) != 0) {
            throw std::runtime_error(
                "Flushing " + std::string(description) + " failed: " +
                std::error_code(errno, std::generic_category()).message() +
                ".");
        }
        struct stat opened {};
        struct stat named {};
        if (
            ::fstat(descriptor.get(), &opened) != 0 ||
            ::lstat(staging.c_str(), &named) != 0 ||
            !S_ISREG(named.st_mode) ||
            opened.st_dev != named.st_dev ||
            opened.st_ino != named.st_ino) {
            throw std::runtime_error(
                "Atomic-write staging identity changed before commit.");
        }
        if (descriptor.close() != 0) {
            const int error = errno;
            throw std::runtime_error(
                "Closing " + std::string(description) + " failed: " +
                std::error_code(error, std::generic_category()).message() +
                ".");
        }
        replace_file(staging, destination);
    } catch (...) {
        static_cast<void>(::unlink(staging.c_str()));
        throw;
    }
#endif
}

inline void write_file_atomically(
    const std::filesystem::path& destination,
    std::span<const std::uint8_t> bytes,
    std::size_t maximum_bytes,
    std::string_view description) {
    write_file_atomically_with_staging_paths(
        destination,
        bytes,
        maximum_bytes,
        description,
        [](const std::filesystem::path& path, std::size_t) {
            return random_staging_path(path);
        });
}

inline void write_file_atomically(
    const std::filesystem::path& destination,
    std::string_view text,
    std::size_t maximum_bytes,
    std::string_view description) {
    write_file_atomically(
        destination,
        std::span<const std::uint8_t>{
            reinterpret_cast<const std::uint8_t*>(text.data()),
            text.size()},
        maximum_bytes,
        description);
}

} // namespace bbl::pal::detail
