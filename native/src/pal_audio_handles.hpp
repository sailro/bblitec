#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <vector>

namespace bbl::pal::audio_handles {

inline constexpr std::uint32_t max_component = 0xffffu;

inline void require_context_id(std::uint32_t context) {
    if (context == 0 || context > max_component) {
        throw std::runtime_error("Audio context handle space exhausted.");
    }
}

inline std::uint32_t pack(std::uint32_t context, std::uint32_t index) {
    require_context_id(context);
    if (index > max_component) {
        throw std::runtime_error("Too many audio nodes or buffers in one context.");
    }
    return (context << 16) | index;
}

constexpr std::uint32_t context_of(std::uint32_t packed) { return packed >> 16; }
constexpr std::uint32_t index_of(std::uint32_t packed) { return packed & max_component; }

/** Non-owning registry. A live JS handle pins its slot; reuse is checked
 * against allocation identity as well as the packed index. */
template <typename T>
class Registry {
    static constexpr std::uint32_t end = 0xffffffffu;
    struct Slot {
        std::weak_ptr<T> value;
        std::uint32_t next = end;
    };
    struct State {
        std::mutex mutex;
        std::vector<Slot> slots;
        std::uint32_t free = end;
        void release_unlocked(std::uint32_t index) noexcept {
            slots[index].value.reset();
            slots[index].next = free;
            free = index;
        }
        void release(std::uint32_t index) noexcept {
            const std::lock_guard lock(mutex);
            release_unlocked(index);
        }
    };
    struct Owner {
        std::shared_ptr<T> value;
        std::shared_ptr<State> state;
        std::uint32_t index;
        Owner(std::shared_ptr<T> object, std::shared_ptr<State> registry, std::uint32_t slot)
            : value(std::move(object)), state(std::move(registry)), index(slot) {}
        ~Owner() { state->release(index); }
    };

public:
    struct Entry {
        std::uint32_t index;
        std::shared_ptr<T> ownership;
    };

    Entry insert(std::shared_ptr<T> value) {
        const std::lock_guard lock(state_->mutex);
        std::uint32_t index = state_->free;
        if (index == end) {
            if (state_->slots.size() > max_component) {
                throw std::runtime_error("Too many live audio nodes or buffers in one context.");
            }
            index = static_cast<std::uint32_t>(state_->slots.size());
            state_->slots.emplace_back();
        } else state_->free = state_->slots[index].next;
        try {
            auto owner = std::make_shared<Owner>(value, state_, index);
            std::shared_ptr<T> identity(owner, value.get());
            state_->slots[index].value = identity;
            return {index, std::move(identity)};
        } catch (...) {
            state_->release_unlocked(index);
            throw;
        }
    }

    bool contains(std::uint32_t index, const std::shared_ptr<T>& identity) const {
        std::shared_ptr<T> current;
        {
            const std::lock_guard lock(state_->mutex);
            if (index < state_->slots.size()) current = state_->slots[index].value.lock();
        }
        return identity && current == identity;
    }

    template <typename F>
    void for_each_live(F action) {
        if (!state_) return;
        for (std::size_t index = 0;; ++index) {
            std::shared_ptr<T> value;
            {
                const std::lock_guard lock(state_->mutex);
                if (index == state_->slots.size()) break;
                value = state_->slots[index].value.lock();
            }
            if (value) action(*value);
        }
    }

    std::size_t capacity() const {
        const std::lock_guard lock(state_->mutex);
        return state_->slots.size();
    }

private:
    std::shared_ptr<State> state_ = std::make_shared<State>();
};

} // namespace bbl::pal::audio_handles
