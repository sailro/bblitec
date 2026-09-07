#pragma once

#include <bblite/pal_offscreen.hpp>
#include <vector>

namespace bbl::pal {

/** Reuse a GPU image only when no mailbox, presenter, or GPU fence leases it. */
template <typename Image>
class OffscreenImagePool {
  public:
    template <typename Create>
    Image* acquire(std::uint32_t width, std::uint32_t height, OffscreenRun& run, Create&& create) {
        if (width_ != width || height_ != height) {
            images_.clear();
            width_ = width;
            height_ = height;
        }
        current_.reset();
        const auto find_available = [&] {
            return std::find_if(images_.begin(), images_.end(),
                [](const auto& image) { return image.use_count() == 1; });
        };
        auto available = find_available();
        if (available == images_.end() && images_.size() == 3) {
            run.discard_pending();
            available = find_available();
        }
        if (available != images_.end()) {
            current_ = *available;
        } else if (images_.size() < 3) {
            current_ = create(width, height);
            images_.push_back(current_);
        } else {
            return nullptr;
        }
        return current_.get();
    }

    /** Call only after submitting the producing command buffer. */
    void publish(OffscreenRun& run) {
        run.publish(width_, height_, current_);
        current_.reset();
    }

  private:
    std::vector<std::shared_ptr<Image>> images_;
    std::shared_ptr<Image> current_;
    std::uint32_t width_ = 0;
    std::uint32_t height_ = 0;
};

} // namespace bbl::pal
