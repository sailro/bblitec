#pragma once
#include <bblite/features/has_billboards.hpp>
#include <bblite/upstream/render_capabilities.hpp>

// Generated variant families share uniform mirrors in this declaration order.
#if BBLITE_HAS_BILLBOARDS
#include <bblite/upstream/billboard_system.hpp>
#endif
#if BBLITE_PBR_VARIANTS > 0
#include <bblite/upstream/pbr_variants.hpp>
#endif
#if BBLITE_STANDARD_VARIANTS > 0
#include <bblite/upstream/standard_variants.hpp>
#endif
#if BBLITE_NODE_VARIANTS > 0
#include <bblite/upstream/node_variants.hpp>
#endif
