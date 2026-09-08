#include <bblite/pal_physics_debug.hpp>

#include <algorithm>
#include <fstream>
#include <iomanip>
#include <limits>

namespace bbl::pal {
namespace {
thread_local std::vector<PhysicsDebugShapeDescriptor> collected_descriptors;

void write_descriptor(std::ostream& output, const PhysicsDebugShapeDescriptor& descriptor) {
    output << "{\"type\":" << std::quoted(descriptor.type) << ",\"parameters\":[";
    for (std::size_t i = 0; i < descriptor.parameters.size(); ++i) {
        if (i != 0) output << ',';
        output << descriptor.parameters[i];
    }
    output << "],\"indices\":[";
    for (std::size_t i = 0; i < descriptor.indices.size(); ++i) {
        if (i != 0) output << ',';
        output << descriptor.indices[i];
    }
    output << "],\"children\":[";
    for (std::size_t i = 0; i < descriptor.children.size(); ++i) {
        if (i != 0) output << ',';
        write_descriptor(output, descriptor.children[i]);
    }
    output << "]}";
}
} // namespace

PhysicsDebugExtractionScope::PhysicsDebugExtractionScope() {
    if (extracting_constructor_inputs) throw std::runtime_error("Nested constructor extraction is not supported.");
    collected_descriptors.clear();
    extracting_constructor_inputs = true;
}
PhysicsDebugExtractionScope::~PhysicsDebugExtractionScope() {
    extracting_constructor_inputs = false;
    collected_descriptors.clear();
}
bool collect_physics_debug_descriptor(const PhysicsDebugShapeDescriptor& descriptor) {
    if (!extracting_constructor_inputs) return false;
    if (std::find(collected_descriptors.begin(), collected_descriptors.end(), descriptor) == collected_descriptors.end()) {
        collected_descriptors.push_back(descriptor);
    }
    return true;
}
void PhysicsDebugExtractionScope::write(const char* output_path) const {
    std::ofstream output(output_path, std::ios::binary | std::ios::trunc);
    output.exceptions(std::ios::badbit | std::ios::failbit);
    output << std::setprecision(std::numeric_limits<float>::max_digits10) << '[';
    for (std::size_t i = 0; i < collected_descriptors.size(); ++i) {
        if (i != 0) output << ',';
        write_descriptor(output, collected_descriptors[i]);
    }
    output << "]\n";
}
} // namespace bbl::pal
