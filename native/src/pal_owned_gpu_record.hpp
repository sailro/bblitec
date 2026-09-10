#pragma once

#include <type_traits>
#include <utility>

namespace bbl::pal {

// A backend record owns its handles from the first upload through publication,
// vector moves and teardown. The backend supplies dependency-ordered release.
template <typename Resources, typename Owner>
void release_owned_gpu_record(Owner* owner, Resources& resources) noexcept {
    owner->release_gpu_resources(resources);
}

template <typename Resources, typename Owner, auto Release = &release_owned_gpu_record<Resources, Owner>>
class OwnedGpuRecord : public Resources {
    static_assert(std::is_nothrow_move_assignable_v<Resources>);
    Owner* owner_ = nullptr;

public:
    OwnedGpuRecord() = default;
    explicit OwnedGpuRecord(Owner& owner) : owner_(&owner) {}
    explicit OwnedGpuRecord(Owner* owner) : owner_(owner) {}
    OwnedGpuRecord(const OwnedGpuRecord&) = delete;
    OwnedGpuRecord& operator=(const OwnedGpuRecord&) = delete;

    // Default construction may allocate container sentinels. Finish that
    // before transferring any raw handles from the still-owned source.
    OwnedGpuRecord(OwnedGpuRecord&& other)
        noexcept(std::is_nothrow_default_constructible_v<Resources>)
        : OwnedGpuRecord() {
        Resources::operator=(std::move(other));
        owner_ = std::exchange(other.owner_, nullptr);
    }

    OwnedGpuRecord& operator=(OwnedGpuRecord&& other) noexcept {
        if (this != &other) {
            reset();
            Resources::operator=(std::move(other));
            owner_ = std::exchange(other.owner_, nullptr);
        }
        return *this;
    }

    ~OwnedGpuRecord() { reset(); }

    void reset() noexcept {
        if (Owner* owner = std::exchange(owner_, nullptr)) {
            Release(owner, static_cast<Resources&>(*this));
        }
    }
};

} // namespace bbl::pal
