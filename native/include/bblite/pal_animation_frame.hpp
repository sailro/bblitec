#pragma once

#include <bblite/pal_event_loop.hpp>

namespace bbl::pal {

/** A Window's repaint clock, shared with its dedicated workers. It retains
 * only weak native inboxes, never realm callbacks or JavaScript state. */
class AnimationFrameSource {
public:
    class Batch {
    public:
        Batch() = default;
        bool ready() const {
            return std::all_of(receipts_.begin(), receipts_.end(), [](const auto& receipt) {
                const auto inbox = receipt.inbox.lock();
                return !inbox || inbox->animation_frame_complete(receipt.serial);
            });
        }

    private:
        friend class AnimationFrameSource;
        struct Receipt {
            std::weak_ptr<EventLoop::Inbox> inbox;
            std::uint64_t serial;
        };
        std::vector<Receipt> receipts_;
    };

    void subscribe(const std::shared_ptr<EventLoop::Inbox>& inbox) {
        if (!inbox)
            throw std::invalid_argument("Animation frames require a realm inbox.");
        std::lock_guard lock(mutex_);
        for (const auto& subscriber : subscribers_)
            if (subscriber.lock() == inbox)
                return;
        subscribers_.push_back(inbox);
    }
    Batch tick(EventLoop::Clock::time_point timestamp) {
        Batch batch;
        std::lock_guard lock(mutex_);
        batch.receipts_.reserve(subscribers_.size());
        std::erase_if(subscribers_, [&](const auto& subscriber) {
            if (const auto inbox = subscriber.lock()) {
                if (const auto serial = inbox->animation_frame(timestamp))
                    batch.receipts_.push_back({inbox, serial});
                return false;
            }
            return true;
        });
        return batch;
    }

private:
    std::mutex mutex_;
    std::vector<std::weak_ptr<EventLoop::Inbox>> subscribers_;
};

} // namespace bbl::pal
