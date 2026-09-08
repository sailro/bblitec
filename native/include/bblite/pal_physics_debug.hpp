#pragma once

#include <bblite/pal_physics.hpp>
#include <bblite/pal_construction.hpp>
#include <span>
#include <string>

namespace bbl::pal {

/** Ordered HP_Shape constructor inputs, before solver-specific shaping.
 * Container parameters hold one position/quaternion/scale tuple per child. */
struct PhysicsDebugShapeDescriptor {
    std::string type;
    std::vector<float> parameters;
    std::vector<std::uint32_t> indices;
    std::vector<PhysicsDebugShapeDescriptor> children;
    friend bool operator==(const PhysicsDebugShapeDescriptor&, const PhysicsDebugShapeDescriptor&) = default;
};

struct PhysicsDebugGeometry {
    std::span<const float> positions;
    std::span<const std::uint32_t> indices;
};

/** Immutable catalog selection compares every constructor input. */
PhysicsDebugGeometry materialized_physics_debug_geometry(const PhysicsDebugShapeDescriptor& descriptor);
PhysicsDebugShapeDescriptor physics_shape_debug_descriptor(PhysicsShapeHandle shape);
PhysicsDebugGeometry physics_body_debug_geometry(PhysicsBodyHandle body);

class PhysicsDebugExtractionScope {
public:
    PhysicsDebugExtractionScope();
    ~PhysicsDebugExtractionScope();
    PhysicsDebugExtractionScope(const PhysicsDebugExtractionScope&) = delete;
    PhysicsDebugExtractionScope& operator=(const PhysicsDebugExtractionScope&) = delete;
    void write(const char* output_path) const;
};
/** Returns true only in the compiler-generated construction entry. */
bool collect_physics_debug_descriptor(const PhysicsDebugShapeDescriptor& descriptor);

} // namespace bbl::pal
