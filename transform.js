/**
 * Transform raw FHIR resources into the dashboard's data format
 *
 * Maps FHIR R4 resources → the PROVIDERS, PATIENTS, DIAGNOSES, etc.
 * data structures used by index.html
 */

// ========================================
// CPT CODE LOOKUPS
// ========================================

const DEBRIDEMENT_CPTS = ['97597', '97598', '97602', '11042', '11043', '11044'];
const SURGICAL_CPTS = ['11042', '11043', '11044', '15271', '15275', '28001'];
const MIST_CPTS = ['0101T', '28220']; // MIST therapy / ultrasonic debridement
const EM_CODES = ['99211', '99212', '99213', '99214', '99215', '99232', '99233'];
const COMPRESSION_HCPCS = ['A6530', 'A6531', 'A6532', 'A6545'];

// ICD-10 code prefixes for wound types
const WOUND_ICD10 = {
  DFU: ['E11.621', 'E11.622', 'E11.628', 'E10.621', 'E10.622'],
  VLU: ['I87.2', 'I87.01', 'I87.011', 'I87.012', 'I87.019'],
  PRESSURE: ['L89'],
  ARTERIAL: ['I70.25', 'I70.24', 'I70.23', 'I73.9'],
  SURGICAL: ['T81.31', 'T81.32'],
  TRAUMATIC: ['T14.1', 'T14.8']
};

const PALLIATIVE_CODES = ['Z51.5'];
const CLOSURE_CODE = 'Z51.89';
const DIABETIC_ULCER_CODES = ['E11.621', 'E11.622', 'E11.628', 'E10.621', 'E10.622'];

// Referral type identification from ServiceRequest (text patterns + SNOMED codes)
const REFERRAL_PATTERNS = {
  endocrinology: ['endocrin', 'diabetes', 'endo', 'hba1c', 'glyc'],
  vascular: ['vascular', 'vasc surg', 'vein', 'arteri', 'bypass', 'angioplasty'],
  podiatry: ['podiatr', 'foot', 'pod', 'hallux', 'metatarsal', 'toe'],
  hospice: ['hospice', 'palliative', 'end of life', 'comfort care'],
  abi: ['abi', 'ankle brachial', 'ankle-brachial'],
  venousUS: ['venous ultrasound', 'venous duplex', 'venous us', 'lower extremity venous', 'venous reflux'],
  arterialUS: ['arterial ultrasound', 'arterial duplex', 'arterial us', 'lower extremity arterial'],
  radiology: ['x-ray', 'xray', 'ct scan', 'mri', 'imaging', 'radiol', 'radiograph'],
  dme: ['dme', 'durable medical', 'brace', 'boot', 'wheelchair', 'offloading', 'compression stocking', 'walker']
};

// SNOMED codes for common order types
const SNOMED_ORDER_CODES = {
  '12350003': 'abi',           // ABI procedure
  '241615005': 'venousUS',     // Venous duplex
  '709979009': 'arterialUS',   // Arterial duplex
  '15220000': 'laboratory',    // Lab test
  '104001': 'culture',         // Culture
  '306181000': 'endocrinology',// Referral to endocrinology
  '306286007': 'vascular',     // Referral to vascular
  '306181005': 'podiatry',     // Referral to podiatry
  '306237005': 'hospice',      // Referral to hospice
  '363680008': 'radiology',    // Radiography
  '360030002': 'dme',          // Prosthesis fitting
};

// ========================================
// HELPER FUNCTIONS
// ========================================

function getCodeFromCoding(codingArray) {
  if (!codingArray) return null;
  const codings = Array.isArray(codingArray) ? codingArray : [codingArray];
  for (const coding of codings) {
    if (coding.coding) {
      for (const c of coding.coding) {
        if (c.code) return c.code;
      }
    }
    if (coding.code) return coding.code;
  }
  return null;
}

function getAllCodes(resource) {
  const codes = [];
  if (resource.code?.coding) {
    for (const c of resource.code.coding) {
      if (c.code) codes.push(c.code);
    }
  }
  if (resource.code?.text) codes.push(resource.code.text);
  return codes;
}

function getPatientRef(resource) {
  const ref = resource.subject?.reference || resource.patient?.reference || '';
  return ref.replace('Patient/', '');
}

function getPractitionerRef(resource) {
  // Check various locations for practitioner references
  if (resource.performer?.[0]?.reference) return resource.performer[0].reference.replace('Practitioner/', '');
  if (resource.participant?.[0]?.individual?.reference) return resource.participant[0].individual.reference.replace('Practitioner/', '');
  if (resource.requester?.reference) return resource.requester.reference.replace('Practitioner/', '');
  if (resource.recorder?.reference) return resource.recorder.reference.replace('Practitioner/', '');
  return null;
}

function codeStartsWith(code, prefixes) {
  if (!code) return false;
  return prefixes.some(p => code.startsWith(p));
}

function matchesPattern(text, patterns) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return patterns.some(p => lower.includes(p));
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.abs(Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
}

function getResourceDate(resource) {
  return resource.performedDateTime ||
    resource.performedPeriod?.start ||
    resource.authoredOn ||
    resource.occurrenceDateTime ||
    resource.effectiveDateTime ||
    resource.period?.start ||
    resource.meta?.lastUpdated;
}

// ========================================
// MAIN TRANSFORM FUNCTION
// ========================================

function transformToDatabase(fhirData) {
  const {
    patients,
    conditions,
    procedures,
    encounters,
    observations,
    serviceRequests,
    medicationRequests,
    practitioners,
    locations,
    coverages,
    diagnosticReports
  } = fhirData;

  // Build practitioner lookup
  const practitionerMap = {};
  for (const p of practitioners) {
    const id = p.id;
    const name = p.name?.[0];
    const fullName = name ? `${name.prefix?.[0] || ''} ${name.given?.[0] || ''} ${name.family || ''}`.trim() : `Provider ${id}`;
    practitionerMap[id] = {
      id,
      name: fullName,
      initials: (name?.given?.[0]?.[0] || '') + (name?.family?.[0] || ''),
      specialty: p.qualification?.[0]?.code?.text || 'General'
    };
  }

  // Build patient lookup with first encounter dates
  const patientMap = {};
  for (const p of patients) {
    patientMap[p.id] = {
      id: p.id,
      name: p.name?.[0] ? `${p.name[0].given?.[0] || ''} ${p.name[0].family || ''}`.trim() : `Patient ${p.id}`,
      firstEncounterDate: null
    };
  }

  // Find first encounter date per patient
  for (const enc of encounters) {
    const patId = getPatientRef(enc);
    const date = enc.period?.start || enc.meta?.lastUpdated;
    if (patId && patientMap[patId] && date) {
      if (!patientMap[patId].firstEncounterDate || date < patientMap[patId].firstEncounterDate) {
        patientMap[patId].firstEncounterDate = date;
      }
    }
  }

  // ========================================
  // PER-PROVIDER AGGREGATION
  // ========================================

  const providerStats = {};

  function ensureProvider(practId) {
    if (!providerStats[practId]) {
      const pract = practitionerMap[practId] || { name: `Unknown (${practId})`, initials: '??', specialty: 'Unknown' };
      providerStats[practId] = {
        ...pract,
        activeWounds: 0, healingRate: 0, avgDays: 0, visitCompliance: 0,
        woundsTreated: 0, healed: 0, debrideRate: 0, compressionVLU: 0, weeklyVisit: 0,
        ptsOver16w: 0, palliativePts: 0,
        abiOrders: 0, abiOrders30d: 0,
        venousUS: 0, venousUS30d: 0,
        arterialUS: 0, arterialUS30d: 0,
        labOrders: 0, labOrders30d: 0,
        cultureOrders: 0, cultureOrders30d: 0,
        endoRef: 0, vascRef: 0, podRef: 0,
        dmeOrders: 0, rxWritten: 0, radiologyOrders: 0,
        hospiceRef: 0, erSends: 0,
        newPatients: 0, followupPatients: 0,
        mistOrders: 0, z5189Count: 0,
        weeklyVolume: 0, monthlyVolume: 0,
        compressionCodes: { A6530: 0, A6531: 0, A6532: 0, A6545: 0 },
        debridementCPT: { '97597': 0, '97598': 0, '97602': 0, '11042': 0, '11043': 0, '11044': 0 },
        surgicalCPT: { '11042': 0, '11043': 0, '11044': 0, '15271': 0, '15275': 0, '28001': 0 },
        emCodes: { 99211: 0, 99212: 0, 99213: 0, 99214: 0, 99215: 0, 99232: 0, 99233: 0 },
        _patients: new Set(),
        _healDays: [],
        _woundPatients: new Set(),
        _healedPatients: new Set(),
        _encounterDates: []
      };
    }
    return providerStats[practId];
  }

  // --- Process Conditions (ICD-10 diagnoses) ---
  const diagnosisCounts = {};
  for (const cond of conditions) {
    const practId = getPractitionerRef(cond);
    const codes = getAllCodes(cond);
    const patId = getPatientRef(cond);

    for (const code of codes) {
      // Track Z51.89
      if (code === CLOSURE_CODE && practId) {
        ensureProvider(practId).z5189Count++;
      }

      // Track palliative
      if (PALLIATIVE_CODES.includes(code) && practId) {
        ensureProvider(practId).palliativePts++;
      }

      // Track wound diagnoses
      for (const [type, prefixes] of Object.entries(WOUND_ICD10)) {
        if (codeStartsWith(code, prefixes)) {
          diagnosisCounts[type] = (diagnosisCounts[type] || 0) + 1;
          if (practId) {
            const stats = ensureProvider(practId);
            stats._woundPatients.add(patId);
            stats.woundsTreated++;

            if (cond.clinicalStatus?.coding?.[0]?.code === 'resolved' ||
                cond.abatementDateTime) {
              stats.healed++;
              stats._healedPatients.add(patId);

              // Calculate days to heal
              if (cond.onsetDateTime && cond.abatementDateTime) {
                stats._healDays.push(daysBetween(cond.onsetDateTime, cond.abatementDateTime));
              }
            }

            if (cond.clinicalStatus?.coding?.[0]?.code === 'active') {
              stats.activeWounds++;
            }

            // Check treatment duration > 16 weeks
            if (cond.onsetDateTime) {
              const weeksOpen = daysBetween(cond.onsetDateTime, new Date()) / 7;
              if (weeksOpen > 16 && cond.clinicalStatus?.coding?.[0]?.code === 'active') {
                stats.ptsOver16w++;
              }
            }
          }
        }
      }

      // General diagnosis tracking
      diagnosisCounts[code] = (diagnosisCounts[code] || 0) + 1;
    }
  }

  // --- Process Procedures (CPT codes) ---
  for (const proc of procedures) {
    const practId = getPractitionerRef(proc);
    if (!practId) continue;
    const stats = ensureProvider(practId);
    const codes = getAllCodes(proc);

    for (const code of codes) {
      // Debridement CPTs
      if (DEBRIDEMENT_CPTS.includes(code) && stats.debridementCPT[code] !== undefined) {
        stats.debridementCPT[code]++;
      }

      // Surgical CPTs
      if (SURGICAL_CPTS.includes(code) && stats.surgicalCPT[code] !== undefined) {
        stats.surgicalCPT[code]++;
      }

      // MIST
      if (MIST_CPTS.includes(code)) {
        stats.mistOrders++;
      }

      // E/M codes
      if (EM_CODES.includes(code) && stats.emCodes[parseInt(code)] !== undefined) {
        stats.emCodes[parseInt(code)]++;
      }

      // Compression codes
      if (COMPRESSION_HCPCS.includes(code) && stats.compressionCodes[code] !== undefined) {
        stats.compressionCodes[code]++;
      }
    }
  }

  // --- Process Encounters (visits, volume, AND CPT codes) ---
  // AdvancedMD puts CPT codes in Encounter.type, not in Procedure
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);

  for (const enc of encounters) {
    const practId = getPractitionerRef(enc);
    if (!practId) continue;
    const stats = ensureProvider(practId);
    const patId = getPatientRef(enc);
    const encDate = enc.period?.start || enc.meta?.lastUpdated;

    stats._encounterDates.push(encDate);

    // Track unique patients
    if (patId) {
      if (!stats._patients.has(patId)) {
        stats.newPatients++;
        stats._patients.add(patId);
      } else {
        stats.followupPatients++;
      }
    }

    // Extract CPT codes from encounter.type (AdvancedMD format)
    // e.g. type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99214" }] }]
    for (const typeEntry of (enc.type || [])) {
      for (const coding of (typeEntry.coding || [])) {
        const code = coding.code;
        if (!code) continue;

        // E/M codes
        if (EM_CODES.includes(code) && stats.emCodes[parseInt(code)] !== undefined) {
          stats.emCodes[parseInt(code)]++;
        }

        // Debridement CPTs
        if (DEBRIDEMENT_CPTS.includes(code) && stats.debridementCPT[code] !== undefined) {
          stats.debridementCPT[code]++;
        }

        // Surgical CPTs
        if (SURGICAL_CPTS.includes(code) && stats.surgicalCPT[code] !== undefined) {
          stats.surgicalCPT[code]++;
        }

        // MIST
        if (MIST_CPTS.includes(code)) {
          stats.mistOrders++;
        }

        // Compression codes
        if (COMPRESSION_HCPCS.includes(code) && stats.compressionCodes[code] !== undefined) {
          stats.compressionCodes[code]++;
        }
      }
    }

    // ER sends — check encounter type/disposition
    const encType = enc.type?.[0]?.coding?.[0]?.code || enc.type?.[0]?.text || '';
    const encTypeDisplay = enc.type?.[0]?.coding?.[0]?.display || enc.type?.[0]?.text || '';
    const disposition = enc.hospitalization?.dischargeDisposition?.coding?.[0]?.code || '';
    if (encTypeDisplay.toLowerCase().includes('emergency') || disposition.includes('er') || disposition.includes('emergency')) {
      stats.erSends++;
    }
  }

  // --- Process ServiceRequests (orders, referrals) ---
  for (const sr of serviceRequests) {
    const practId = getPractitionerRef(sr);
    if (!practId) continue;
    const stats = ensureProvider(practId);
    const patId = getPatientRef(sr);
    const orderDate = sr.authoredOn;
    const codes = getAllCodes(sr);
    const codeText = (sr.code?.text || '').toLowerCase();
    const allDisplays = (sr.code?.coding || []).map(c => (c.display || '').toLowerCase()).join(' ');
    const allText = codes.join(' ').toLowerCase() + ' ' + codeText + ' ' + allDisplays;

    // Check SNOMED codes for direct matching
    const snomedCategory = codes.find(c => SNOMED_ORDER_CODES[c]);
    const snomedMatch = snomedCategory ? SNOMED_ORDER_CODES[snomedCategory] : null;

    // Also check category coding (AdvancedMD uses SNOMED in category)
    const categoryCodes = (sr.category || []).flatMap(cat => (cat.coding || []).map(c => c.code));
    const categoryMatch = categoryCodes.find(c => SNOMED_ORDER_CODES[c]);
    const catSnomedMatch = categoryMatch ? SNOMED_ORDER_CODES[categoryMatch] : null;

    // Determine first visit date for this patient
    const firstVisit = patientMap[patId]?.firstEncounterDate;
    const within30d = firstVisit && orderDate && daysBetween(firstVisit, orderDate) <= 30;

    // ABI orders
    if (snomedMatch === 'abi' || catSnomedMatch === 'abi' || matchesPattern(allText, REFERRAL_PATTERNS.abi)) {
      stats.abiOrders++;
      if (within30d) stats.abiOrders30d++;
    }

    // Venous ultrasound
    if (matchesPattern(allText, REFERRAL_PATTERNS.venousUS)) {
      stats.venousUS++;
      if (within30d) stats.venousUS30d++;
    }

    // Arterial ultrasound
    if (matchesPattern(allText, REFERRAL_PATTERNS.arterialUS)) {
      stats.arterialUS++;
      if (within30d) stats.arterialUS30d++;
    }

    // Lab orders
    if (sr.category?.[0]?.coding?.[0]?.code === 'laboratory' || matchesPattern(allText, ['lab', 'cbc', 'cmp', 'hba1c', 'hemoglobin', 'albumin', 'prealbumin'])) {
      stats.labOrders++;
      if (within30d) stats.labOrders30d++;
    }

    // Culture orders
    if (matchesPattern(allText, ['culture', 'c&s', 'wound culture', 'blood culture'])) {
      stats.cultureOrders++;
      if (within30d) stats.cultureOrders30d++;
    }

    // Specialty referrals
    if (matchesPattern(allText, REFERRAL_PATTERNS.endocrinology)) stats.endoRef++;
    if (matchesPattern(allText, REFERRAL_PATTERNS.vascular)) stats.vascRef++;
    if (matchesPattern(allText, REFERRAL_PATTERNS.podiatry)) stats.podRef++;
    if (matchesPattern(allText, REFERRAL_PATTERNS.hospice)) stats.hospiceRef++;
    if (matchesPattern(allText, REFERRAL_PATTERNS.radiology)) stats.radiologyOrders++;
    if (matchesPattern(allText, REFERRAL_PATTERNS.dme)) stats.dmeOrders++;
  }

  // --- Process MedicationRequests (prescriptions) ---
  for (const med of medicationRequests) {
    const practId = getPractitionerRef(med);
    if (practId) {
      ensureProvider(practId).rxWritten++;
    }
  }

  // --- Calculate derived metrics per provider ---
  const providerColors = ['#2d4a7a', '#d4a732', '#4a7ab5', '#16a34a', '#dc2626', '#6b8db5', '#7c3aed', '#f59e0b'];

  const PROVIDERS = Object.values(providerStats).map((stats, i) => {
    // Calculate heal rate
    if (stats.woundsTreated > 0) {
      stats.healingRate = Math.round((stats.healed / stats.woundsTreated) * 100);
    }

    // Calculate avg days to heal
    if (stats._healDays.length > 0) {
      stats.avgDays = Math.round(stats._healDays.reduce((a, b) => a + b, 0) / stats._healDays.length);
    }

    // Calculate volume metrics
    if (stats._encounterDates.length > 0) {
      const dates = stats._encounterDates.map(d => new Date(d)).sort((a, b) => a - b);
      const spanWeeks = Math.max(1, daysBetween(dates[0], dates[dates.length - 1]) / 7);
      const spanMonths = Math.max(1, spanWeeks / 4.33);
      stats.weeklyVolume = Math.round(stats._encounterDates.length / spanWeeks);
      stats.monthlyVolume = Math.round(stats._encounterDates.length / spanMonths);
    }

    // Calculate debridement rate
    const totalDebridements = Object.values(stats.debridementCPT).reduce((a, b) => a + b, 0);
    stats.debrideRate = stats.woundsTreated > 0 ? Math.round((totalDebridements / stats.woundsTreated) * 100) : 0;

    // Calculate compression rate for VLU
    const totalCompression = Object.values(stats.compressionCodes).reduce((a, b) => a + b, 0);
    stats.compressionVLU = totalCompression; // We'd need VLU-specific patient count for a real rate

    // Assign color
    stats.color = providerColors[i % providerColors.length];

    // Clean up internal tracking fields
    delete stats._patients;
    delete stats._healDays;
    delete stats._woundPatients;
    delete stats._healedPatients;
    delete stats._encounterDates;

    return stats;
  });

  // --- Build Diagnoses list ---
  const DIAGNOSES = Object.entries(diagnosisCounts)
    .filter(([code]) => {
      // Only include wound-specific ICD-10 codes
      return Object.values(WOUND_ICD10).flat().some(prefix => code.startsWith(prefix));
    })
    .map(([code, count], i) => ({
      code,
      name: getWoundTypeName(code),
      count,
      color: providerColors[i % providerColors.length]
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // --- Build Locations list ---
  const LOCATIONS = locations.map(loc => ({
    id: loc.id,
    name: loc.name || 'Unknown',
    address: loc.address ? `${loc.address.line?.[0] || ''}, ${loc.address.city || ''}, ${loc.address.state || ''} ${loc.address.postalCode || ''}` : '',
    zip: loc.address?.postalCode || ''
  }));

  // --- Build Coverage/Insurance summary ---
  const insuranceCounts = {};
  for (const cov of coverages) {
    const payorName = cov.payor?.[0]?.display || cov.class?.[0]?.name || 'Unknown';
    insuranceCounts[payorName] = (insuranceCounts[payorName] || 0) + 1;
  }

  const INSURANCE = Object.entries(insuranceCounts)
    .map(([name, count], i) => ({
      name,
      activePatients: count,
      color: providerColors[i % providerColors.length]
    }))
    .sort((a, b) => b.activePatients - a.activePatients);

  return {
    providers: PROVIDERS,
    diagnoses: DIAGNOSES,
    locations: LOCATIONS,
    insurance: INSURANCE,
    summary: {
      totalPatients: patients.length,
      totalEncounters: encounters.length,
      totalConditions: conditions.length,
      totalProcedures: procedures.length,
      totalProviders: PROVIDERS.length,
      dataSource: 'AdvancedMD FHIR R4'
    }
  };
}

function getWoundTypeName(code) {
  const names = {
    'E11.621': 'Diabetic Foot Ulcer (R)',
    'E11.622': 'Diabetic Foot Ulcer (L)',
    'E11.628': 'Diabetic Foot Ulcer (Other)',
    'E10.621': 'Type 1 DFU (R)',
    'E10.622': 'Type 1 DFU (L)',
    'I87.2': 'Venous Leg Ulcer',
    'I87.01': 'Post-thrombotic VLU',
    'L89': 'Pressure Injury',
    'I70.25': 'Arterial Ulcer',
    'I70.24': 'Arterial Ulcer (Leg)',
    'I73.9': 'Peripheral Vascular Disease',
    'T81.31': 'Surgical Wound Dehiscence',
    'T81.32': 'Surgical Wound Disruption',
    'T14.1': 'Traumatic Wound',
    'T14.8': 'Traumatic Wound (Other)'
  };
  // Match by prefix
  for (const [prefix, name] of Object.entries(names)) {
    if (code.startsWith(prefix)) return name;
  }
  return code;
}

module.exports = { transformToDatabase: transformToDatabase };

// Allow running standalone for testing
if (require.main === module) {
  console.log('Transform module loaded. Use transformToDatabase(fhirData) to convert FHIR resources.');
}
