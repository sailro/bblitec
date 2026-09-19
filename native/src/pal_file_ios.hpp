#pragma once

#include <bblite/pal.hpp>

namespace bbl::pal {

std::optional<SelectedFileSnapshot> choose_ios_open_file(const FileDialogOptions& options);
bool export_ios_file(const FileDialogOptions& options, std::span<const std::uint8_t> bytes);

} // namespace bbl::pal
