/** DOM string storage shared by ordinary canvas handshakes and recovery callbacks. */
export const canvasDatasetSource = `
#include <iostream>

namespace bbl {
void set_canvas_dataset(Engine& engine, std::string key, std::string value) {
    static const bool trace = pal::environment_variable("BBLITE_RUNTIME_TRACE") == "1";
    const auto entry = engine.canvas_dataset.try_emplace(std::move(key)).first;
    auto& current = entry->second;
    if (trace && current != value) {
        std::cerr << "[bblite trace] dataset " << entry->first << "=" << value << '\\n';
    }
    current = std::move(value);
}
std::string canvas_dataset(const Engine& engine, const std::string& key) {
    const auto found = engine.canvas_dataset.find(key);
    return found == engine.canvas_dataset.end() ? std::string{} : found->second;
}
} // namespace bbl
`;
