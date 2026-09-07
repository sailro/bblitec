#pragma once

#include <functional>
#include <memory>
#include <vector>

namespace bbl::pal {

/** Source text owners may outlive a renderer run; retire their device leases first. */
class TextResourceRetirement {
public:
    template<class Resource>
    void track(const std::shared_ptr<Resource>& resource) {
        resources_.push_back([weak = std::weak_ptr<Resource>(resource)] {
            if (const auto value = weak.lock()) value->retire();
        });
    }

    void retire() noexcept {
        for (const auto& release : resources_) release();
        resources_.clear();
    }

private:
    std::vector<std::function<void()>> resources_;
};

} // namespace bbl::pal
