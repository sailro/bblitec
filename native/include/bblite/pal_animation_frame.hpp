#pragma once

#include <bblite/pal_event_loop.hpp>

namespace bbl::pal {

/** A Window's repaint clock, shared with its dedicated workers. It retains
 * only weak native inboxes, never realm callbacks or JavaScript state. */
class AnimationFrameSource {
  public:
    void subscribe(const std::shared_ptr<EventLoop::Inbox>& inbox) {
        if (!inbox) throw std::invalid_argument("Animation frames require a realm inbox.");
        std::lock_guard lock(mutex_);
        for (const auto& subscriber : subscribers_) if (subscriber.lock() == inbox) return;
        subscribers_.push_back(inbox);
    }
    void tick(EventLoop::Clock::time_point timestamp) {
        std::lock_guard lock(mutex_);
        std::erase_if(subscribers_, [&](const auto& subscriber) {
            if (const auto inbox = subscriber.lock()) {
                inbox->animation_frame(timestamp);
                return false;
            }
            return true;
        });
    }
  private:
    std::mutex mutex_;
    std::vector<std::weak_ptr<EventLoop::Inbox>> subscribers_;
};

} // namespace bbl::pal
