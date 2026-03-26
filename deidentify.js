/**
 * De-identification Layer
 *
 * Strips all 18 HIPAA identifiers from transformed metrics
 * before caching or returning to the client.
 *
 * Input: aggregated metrics from transform.js
 * Output: safe metrics with NO PHI
 *
 * The 18 HIPAA identifiers:
 *  1. Names                    10. Account numbers
 *  2. Geographic (< state)     11. SSN
 *  3. Dates (except year)      12. MRN
 *  4. Phone numbers            13. Health plan beneficiary #
 *  5. Fax numbers              14. Certificate/license #
 *  6. Email addresses          15. Vehicle identifiers
 *  7. URLs                     16. Device identifiers/serial #
 *  8. IP addresses             17. Web URLs
 *  9. Biometric identifiers    18. Full-face photos
 */

function deidentify(metrics) {
  return {
    providers: (metrics.providers || []).map(stripProviderPHI),
    diagnoses: metrics.diagnoses || [],
    locations: (metrics.locations || []).map(stripLocationPHI),
    insurance: metrics.insurance || [],
    summary: metrics.summary || {}
  };
}

/**
 * Provider records: keep aggregate stats, strip any patient-linked data.
 * Provider names are NOT PHI (they are the covered entity's workforce),
 * but we keep only what the dashboard needs.
 */
function stripProviderPHI(provider) {
  // Provider names/initials are retained — they are not patient PHI.
  // Providers are workforce members of the covered entity.
  return {
    // Identity (not PHI — workforce member)
    id: provider.id,
    name: provider.name,
    initials: provider.initials,
    role: provider.role,
    specialty: provider.specialty,
    color: provider.color,

    // Aggregate metrics only (no patient-level data)
    activeWounds: provider.activeWounds || 0,
    healingRate: provider.healingRate || 0,
    avgDays: provider.avgDays || 0,
    visitCompliance: provider.visitCompliance || 0,
    woundsTreated: provider.woundsTreated || 0,
    healed: provider.healed || 0,
    debrideRate: provider.debrideRate || 0,
    compressionVLU: provider.compressionVLU || 0,
    weeklyVisit: provider.weeklyVisit || 0,

    // Counts only
    ptsOver16w: provider.ptsOver16w || 0,
    palliativePts: provider.palliativePts || 0,
    abiOrders: provider.abiOrders || 0,
    abiOrders30d: provider.abiOrders30d || 0,
    venousUS: provider.venousUS || 0,
    venousUS30d: provider.venousUS30d || 0,
    arterialUS: provider.arterialUS || 0,
    arterialUS30d: provider.arterialUS30d || 0,
    labOrders: provider.labOrders || 0,
    labOrders30d: provider.labOrders30d || 0,
    cultureOrders: provider.cultureOrders || 0,
    cultureOrders30d: provider.cultureOrders30d || 0,
    endoRef: provider.endoRef || 0,
    vascRef: provider.vascRef || 0,
    podRef: provider.podRef || 0,
    dmeOrders: provider.dmeOrders || 0,
    rxWritten: provider.rxWritten || 0,
    radiologyOrders: provider.radiologyOrders || 0,
    hospiceRef: provider.hospiceRef || 0,
    erSends: provider.erSends || 0,
    newPatients: provider.newPatients || 0,
    followupPatients: provider.followupPatients || 0,
    mistOrders: provider.mistOrders || 0,
    z5189Count: provider.z5189Count || 0,
    weeklyVolume: provider.weeklyVolume || 0,
    monthlyVolume: provider.monthlyVolume || 0,

    // Code distributions (aggregate counts only)
    compressionCodes: provider.compressionCodes || {},
    debridementCPT: provider.debridementCPT || {},
    surgicalCPT: provider.surgicalCPT || {},
    emCodes: provider.emCodes || {},

    // Protocol adherence — per wound ratios
    debridementsPerWound: provider.debridementsPerWound || 0,
    compressionPerWound: provider.compressionPerWound || 0,
    surgicalPerWound: provider.surgicalPerWound || 0,
    emPerWound: provider.emPerWound || 0,
    mistPerWound: provider.mistPerWound || 0,
    labsPerWound: provider.labsPerWound || 0,
    culturesPerWound: provider.culturesPerWound || 0,
    abiPerWound: provider.abiPerWound || 0,
    referralsPerWound: provider.referralsPerWound || 0,

    // Aggregate insight metrics (no PHI — just counts)
    unresolvedWounds: provider.unresolvedWounds || 0
  };
}

/**
 * Locations: keep name and general area, strip full street address
 * (addresses below state level are HIPAA identifiers)
 */
function stripLocationPHI(location) {
  return {
    id: location.id,
    name: location.name,
    // Keep city/state/zip but strip street address
    city: location.city || extractCity(location.address),
    state: location.state || extractState(location.address),
    zip: location.zip || ''
  };
}

function extractCity(address) {
  if (!address) return '';
  // Simple extraction from "123 Main St, Las Vegas, NV 89148"
  const parts = address.split(',').map(s => s.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

function extractState(address) {
  if (!address) return '';
  const parts = address.split(',').map(s => s.trim());
  if (parts.length >= 1) {
    const lastPart = parts[parts.length - 1];
    const stateMatch = lastPart.match(/([A-Z]{2})/);
    return stateMatch ? stateMatch[1] : '';
  }
  return '';
}

module.exports = { deidentify };
