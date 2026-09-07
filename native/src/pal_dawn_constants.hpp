#pragma once

#include <webgpu/webgpu.h>

#include <string>
#include <vector>

namespace bbl::pal {

/** Own the numeric override keys while Dawn borrows a stage descriptor. */
class DawnStageConstants {
public:
    template<class Constants>
    explicit DawnStageConstants(const Constants& constants) {
        keys_.reserve(constants.size());
        entries_.reserve(constants.size());
        for (const auto& constant : constants) {
            keys_.push_back(std::to_string(constant.id));
            const auto& key = keys_.back();
            WGPUConstantEntry entry = WGPU_CONSTANT_ENTRY_INIT;
            entry.key = WGPUStringView{key.data(), key.size()};
            entry.value = constant.value;
            entries_.push_back(entry);
        }
    }

    // Entry keys borrow the owned strings, including their inline storage.
    DawnStageConstants(const DawnStageConstants&) = delete;
    DawnStageConstants& operator=(const DawnStageConstants&) = delete;
    DawnStageConstants(DawnStageConstants&&) = delete;
    DawnStageConstants& operator=(DawnStageConstants&&) = delete;

    template<class Stage>
    void apply(Stage& stage) const noexcept {
        stage.constantCount = entries_.size();
        stage.constants = entries_.empty() ? nullptr : entries_.data();
    }

private:
    std::vector<std::string> keys_;
    std::vector<WGPUConstantEntry> entries_;
};

} // namespace bbl::pal
