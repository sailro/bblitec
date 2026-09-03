#pragma once

// The voxel sandbox's save/load file boundary. The pinned module writes
// `JSON.stringify(data)` to a picker-chosen file and reads it back with
// `JSON.parse` plus a shape check; the picker is the host's dialog, reached
// through the PAL, and the document is the pin's own key order, written and
// read here over the generated record. Included only by a scene that
// reaches the boundary (`voxelFileStorageReached`), so the plain-data header
// every scene includes carries no filesystem or stream headers for it.

#include <bblite/js_data.hpp>
#include <bblite/pal.hpp>

#include <cmath>
#include <cstdlib>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>

namespace bbl::js {

inline const pal::FileDialogOptions voxel_file_dialog_options{
    .title = "",
    .suggested_name = "world.voxelsave.json",
    .filter_name = "Voxel world save (*.json)",
    .filter_pattern = "*.json",
};

/**
 * `saveToFile(data)`: the pin's compact `JSON.stringify` of the save record,
 * numbers spelled by the one formatter every string coercion shares.
 */
template <typename SaveData>
[[nodiscard]] inline bool save_voxel_world(
    Engine& engine,
    const SaveData& data) {
    if (!data || !data->player) {
        return false;
    }
    pal::FileDialogOptions options = voxel_file_dialog_options;
    options.title = "Save Voxel World";
    const auto path = pal::choose_save_file(engine, options);
    if (!path) return false;
    const auto number = [](double value) { return NumberPart(value); };
    std::string text = concat(
        "{\"v\":1,\"seed\":", number(data->seed),
        ",\"time\":", number(data->time),
        ",\"player\":{\"x\":", number(data->player->x),
        ",\"y\":", number(data->player->y),
        ",\"z\":", number(data->player->z),
        ",\"yaw\":", number(data->player->yaw),
        ",\"pitch\":", number(data->player->pitch),
        "},\"edits\":[");
    for (std::size_t index = 0; index < data->edits.size(); ++index) {
        if (index != 0) text.push_back(',');
        concat_append(text, number(data->edits[index]));
    }
    text.append("]}");
    pal::write_selected_file_atomically(*path, text);
    return true;
}

/** The reader for the document `save_voxel_world` writes, key by key. */
class VoxelSaveJsonReader {
  public:
    explicit VoxelSaveJsonReader(std::string text)
        : text_(std::move(text)) {}

    [[nodiscard]] bool consume(std::string_view expected) {
        skip_whitespace();
        if (text_.compare(position_, expected.size(), expected) != 0) {
            return false;
        }
        position_ += expected.size();
        return true;
    }

    [[nodiscard]] bool number(double& value) {
        skip_whitespace();
        const char* begin = text_.c_str() + position_;
        char* end = nullptr;
        value = std::strtod(begin, &end);
        if (end == begin || !std::isfinite(value)) {
            return false;
        }
        position_ += static_cast<std::size_t>(end - begin);
        return true;
    }

    [[nodiscard]] bool finished() {
        skip_whitespace();
        return position_ == text_.size();
    }

  private:
    void skip_whitespace() {
        while (
            position_ < text_.size() &&
            is_ascii_whitespace(text_[position_])) {
            ++position_;
        }
    }

    std::string text_;
    std::size_t position_ = 0;
};

/** `loadFromFile()`: an empty handle where the pin resolves `null`. */
template <typename SaveData>
[[nodiscard]] inline SaveData load_voxel_world(
    Engine& engine) {
    pal::FileDialogOptions options = voxel_file_dialog_options;
    options.title = "Load Voxel World";
    const auto file = pal::choose_open_file(engine, options);
    if (!file) return {};
    std::string text(file->bytes.begin(), file->bytes.end());
    VoxelSaveJsonReader reader(std::move(text));
    using SaveRecord = typename SaveData::element_type;
    SaveData data = make_ref<SaveRecord>();
    using PlayerHandle =
        std::remove_cvref_t<decltype(data->player)>;
    using PlayerRecord = typename PlayerHandle::element_type;
    data->player = make_ref<PlayerRecord>();
    double version = 0.0;
    if (!reader.consume("{\"v\":") ||
        !reader.number(version) || version != 1.0 ||
        !reader.consume(",\"seed\":") || !reader.number(data->seed) ||
        !reader.consume(",\"time\":") || !reader.number(data->time) ||
        !reader.consume(",\"player\":{\"x\":") ||
        !reader.number(data->player->x) ||
        !reader.consume(",\"y\":") || !reader.number(data->player->y) ||
        !reader.consume(",\"z\":") || !reader.number(data->player->z) ||
        !reader.consume(",\"yaw\":") || !reader.number(data->player->yaw) ||
        !reader.consume(",\"pitch\":") ||
        !reader.number(data->player->pitch) ||
        !reader.consume("},\"edits\":[")) {
        return {};
    }
    if (!reader.consume("]")) {
        for (;;) {
            double edit = 0.0;
            if (!reader.number(edit)) {
                return {};
            }
            data->edits.push_back(edit);
            if (reader.consume("]")) {
                break;
            }
            if (!reader.consume(",")) {
                return {};
            }
        }
    }
    if (!reader.consume("}") || !reader.finished()) {
        return {};
    }
    data->v = version;
    return data;
}

} // namespace bbl::js
