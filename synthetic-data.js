/**
 * Synthetic FHIR R4 Data Generator
 *
 * Generates realistic wound care patient data matching
 * AdvancedMD's FHIR R4 format. Models WCE's scale:
 * ~1,500 patients, 6 providers, 4 locations, ~5,000 visits/month.
 *
 * NO real PHI — all names, MRNs, and dates are fabricated.
 */

const crypto = require('crypto');

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  patientCount: 1500,
  monthsOfData: 6, // 6 months of encounter history
  visitsPerMonth: 5000,
  practiceId: '47286'
};

// ========================================
// REFERENCE DATA
// ========================================

const PRACTITIONERS = [
  { id: 'pract-001', prefix: 'Dr.', given: 'Naz', family: 'Wahab', specialty: 'Wound Care', role: 'Wound Care / Medical Director', npi: '1677784001' },
  { id: 'pract-002', prefix: 'Dr.', given: 'James', family: 'Chen', specialty: 'Podiatry', role: 'Surgical Podiatry', npi: '1677784002' },
  { id: 'pract-003', prefix: 'Dr.', given: 'Sarah', family: 'Okonkwo', specialty: 'Endocrinology', role: 'Endocrinology', npi: '1677784003' },
  { id: 'pract-004', prefix: 'NP', given: 'Lisa', family: 'Torres', specialty: 'Wound Care', role: 'Wound Care NP', npi: '1677784004' },
  { id: 'pract-005', prefix: 'Dr.', given: 'Amir', family: 'Patel', specialty: 'Infectious Disease', role: 'Infectious Disease', npi: '1677784005' },
  { id: 'pract-006', prefix: 'PA', given: 'Kevin', family: 'Moore', specialty: 'Primary Care', role: 'Primary Care PA', npi: '1677784006' }
];

const LOCATIONS = [
  { id: 'loc-001', name: 'WCE W Sahara Ave', line: '5110 W. Sahara Ave', city: 'Las Vegas', state: 'NV', zip: '89146' },
  { id: 'loc-002', name: 'WCE S Fort Apache', line: '6070 S. Fort Apache Rd Ste 100', city: 'Las Vegas', state: 'NV', zip: '89148' },
  { id: 'loc-003', name: 'WCE S Eastern Ave', line: '8425 S. Eastern Ave', city: 'Las Vegas', state: 'NV', zip: '89123' },
  { id: 'loc-004', name: 'WCE Pahrump', line: '1397 S Loop Rd', city: 'Pahrump', state: 'NV', zip: '89048' }
];

const WOUND_DIAGNOSES = [
  { code: 'E11.621', display: 'Type 2 DM with foot ulcer, right', weight: 18 },
  { code: 'E11.622', display: 'Type 2 DM with foot ulcer, left', weight: 14 },
  { code: 'E11.628', display: 'Type 2 DM with other skin ulcer', weight: 8 },
  { code: 'I87.2', display: 'Venous insufficiency (chronic)(peripheral)', weight: 16 },
  { code: 'I87.011', display: 'Postthrombotic syndrome with ulcer, right', weight: 6 },
  { code: 'I87.012', display: 'Postthrombotic syndrome with ulcer, left', weight: 5 },
  { code: 'L89.150', display: 'Pressure ulcer of sacral region, stage unspecified', weight: 7 },
  { code: 'L89.310', display: 'Pressure ulcer of right buttock, stage unspecified', weight: 4 },
  { code: 'L89.010', display: 'Pressure ulcer of right elbow, stage unspecified', weight: 3 },
  { code: 'I70.25', display: 'Atherosclerosis with ulceration', weight: 6 },
  { code: 'T81.31XA', display: 'Disruption of wound, initial encounter', weight: 5 },
  { code: 'T14.1XXA', display: 'Open wound of unspecified body region', weight: 3 },
  { code: 'Z51.89', display: 'Encounter for other specified aftercare (closure)', weight: 8 },
  { code: 'Z51.5', display: 'Encounter for palliative care', weight: 3 }
];

const COMORBIDITIES = [
  { code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', weight: 35 },
  { code: 'I87.1', display: 'Compression of vein', weight: 20 },
  { code: 'I10', display: 'Essential hypertension', weight: 40 },
  { code: 'I73.9', display: 'Peripheral vascular disease, unspecified', weight: 15 },
  { code: 'E66.01', display: 'Morbid obesity', weight: 25 },
  { code: 'J44.1', display: 'COPD with acute exacerbation', weight: 10 },
  { code: 'N18.3', display: 'Chronic kidney disease, stage 3', weight: 12 },
  { code: 'F41.1', display: 'Generalized anxiety disorder', weight: 14 },
  { code: 'I50.9', display: 'Heart failure, unspecified', weight: 8 },
  { code: 'I48.91', display: 'Unspecified atrial fibrillation', weight: 7 }
];

const DEBRIDEMENT_PROCEDURES = [
  { code: '97597', display: 'Debridement, open wound, first 20 sq cm', weight: 30 },
  { code: '97598', display: 'Debridement, open wound, ea addl 20 sq cm', weight: 18 },
  { code: '97602', display: 'Non-selective debridement', weight: 15 },
  { code: '11042', display: 'Debridement, subcutaneous tissue, first 20 sq cm', weight: 22 },
  { code: '11043', display: 'Debridement, muscle and/or fascia, first 20 sq cm', weight: 10 },
  { code: '11044', display: 'Debridement, bone, first 20 sq cm', weight: 5 }
];

const SURGICAL_PROCEDURES = [
  { code: '15271', display: 'Skin substitute graft, trunk/arms/legs, up to 25 sq cm', weight: 8 },
  { code: '15275', display: 'Skin substitute graft, feet, up to 25 sq cm', weight: 5 },
  { code: '28001', display: 'Incision and drainage, foot bursa', weight: 3 }
];

const MIST_PROCEDURES = [
  { code: '0101T', display: 'Extracorporeal shock wave, wound healing', weight: 4 },
  { code: '28220', display: 'Low-frequency ultrasound debridement', weight: 3 }
];

const EM_CODES = [
  { code: '99211', display: 'Office visit, established, minimal', weight: 5 },
  { code: '99212', display: 'Office visit, established, straightforward', weight: 10 },
  { code: '99213', display: 'Office visit, established, low complexity', weight: 25 },
  { code: '99214', display: 'Office visit, established, moderate complexity', weight: 35 },
  { code: '99215', display: 'Office visit, established, high complexity', weight: 12 },
  { code: '99232', display: 'Subsequent hospital care, moderate', weight: 8 },
  { code: '99233', display: 'Subsequent hospital care, high', weight: 5 }
];

const INSURANCE_CARRIERS = [
  { display: 'Medicare', weight: 32 },
  { display: 'Medicaid', weight: 17 },
  { display: 'Blue Cross Blue Shield', weight: 14 },
  { display: 'United Healthcare', weight: 11 },
  { display: 'Aetna', weight: 9 },
  { display: 'Cigna', weight: 7 },
  { display: 'Self-Pay', weight: 10 }
];

const SERVICE_REQUEST_TYPES = [
  { category: 'abi', display: 'Ankle-Brachial Index', weight: 12 },
  { category: 'venousUS', display: 'Lower Extremity Venous Duplex Ultrasound', weight: 14 },
  { category: 'arterialUS', display: 'Lower Extremity Arterial Duplex Ultrasound', weight: 10 },
  { category: 'laboratory', display: 'CBC with Differential', weight: 20 },
  { category: 'laboratory', display: 'Comprehensive Metabolic Panel', weight: 18 },
  { category: 'laboratory', display: 'HbA1c', weight: 15 },
  { category: 'laboratory', display: 'Prealbumin Level', weight: 10 },
  { category: 'laboratory', display: 'Albumin Level', weight: 12 },
  { category: 'culture', display: 'Wound Culture and Sensitivity', weight: 16 },
  { category: 'culture', display: 'Blood Culture', weight: 4 },
  { category: 'endocrinology', display: 'Referral to Endocrinology', weight: 8 },
  { category: 'vascular', display: 'Referral to WCE Vascular Surgery', weight: 7 },
  { category: 'podiatry', display: 'Referral to WCE Podiatry', weight: 6 },
  { category: 'hospice', display: 'Referral to Hospice Care', weight: 2 },
  { category: 'radiology', display: 'X-Ray Foot 3 Views', weight: 8 },
  { category: 'radiology', display: 'MRI Lower Extremity', weight: 4 },
  { category: 'dme', display: 'Offloading Boot', weight: 10 },
  { category: 'dme', display: 'Compression Stockings Thigh-High', weight: 8 },
  { category: 'dme', display: 'Wheelchair', weight: 3 }
];

const MEDICATIONS = [
  { code: '309362', display: 'Augmentin 875mg', weight: 12 },
  { code: '197511', display: 'Doxycycline 100mg', weight: 10 },
  { code: '312617', display: 'Bactrim DS', weight: 8 },
  { code: '316077', display: 'Metformin 500mg', weight: 15 },
  { code: '197381', display: 'Lisinopril 10mg', weight: 12 },
  { code: '313782', display: 'Gabapentin 300mg', weight: 10 },
  { code: '261106', display: 'Mupirocin 2% Ointment', weight: 14 },
  { code: '199775', display: 'Ibuprofen 800mg', weight: 8 },
  { code: '238133', display: 'Pentoxifylline 400mg', weight: 6 },
  { code: '352272', display: 'Furosemide 40mg', weight: 7 }
];

const COMPRESSION_CODES = [
  { code: 'A6530', display: 'Gradient compression stocking, below knee', weight: 14 },
  { code: 'A6531', display: 'Gradient compression stocking, thigh', weight: 8 },
  { code: 'A6532', display: 'Gradient compression stocking, waist', weight: 4 },
  { code: 'A6545', display: 'Gradient compression wrap, non-elastic', weight: 6 }
];

// ========================================
// NAME GENERATION (synthetic, no real people)
// ========================================

const FIRST_NAMES = [
  'James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda','David','Elizabeth',
  'William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Christopher','Karen',
  'Charles','Lisa','Daniel','Nancy','Matthew','Betty','Anthony','Margaret','Mark','Sandra',
  'Donald','Ashley','Steven','Dorothy','Paul','Kimberly','Andrew','Emily','Joshua','Donna',
  'Kenneth','Michelle','Kevin','Carol','Brian','Amanda','George','Melissa','Timothy','Deborah',
  'Ronald','Stephanie','Edward','Rebecca','Jason','Sharon','Jeffrey','Laura','Ryan','Cynthia',
  'Jacob','Kathleen','Gary','Amy','Nicholas','Angela','Eric','Shirley','Jonathan','Anna',
  'Stephen','Brenda','Larry','Pamela','Justin','Emma','Scott','Nicole','Brandon','Helen',
  'Benjamin','Samantha','Samuel','Katherine','Raymond','Christine','Gregory','Debra','Frank','Rachel',
  'Alexander','Carolyn','Patrick','Janet','Jack','Catherine','Dennis','Maria','Jerry','Heather',
  'Tyler','Diane','Aaron','Ruth','Jose','Julie','Adam','Olivia','Nathan','Joyce',
  'Henry','Virginia','Douglas','Victoria','Peter','Kelly','Zachary','Lauren','Kyle','Christina'
];

const LAST_NAMES = [
  'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
  'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
  'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson',
  'Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores',
  'Green','Adams','Nelson','Baker','Hall','Rivera','Campbell','Mitchell','Carter','Roberts',
  'Turner','Phillips','Evans','Collins','Stewart','Morris','Murphy','Cook','Rogers','Morgan',
  'Peterson','Cooper','Reed','Bailey','Bell','Gomez','Kelly','Howard','Ward','Cox',
  'Diaz','Richardson','Wood','Watson','Brooks','Bennett','Gray','James','Reyes','Cruz',
  'Hughes','Price','Myers','Long','Foster','Sanders','Ross','Morales','Powell','Sullivan',
  'Russell','Ortiz','Jenkins','Gutierrez','Perry','Butler','Barnes','Fisher','Henderson','Coleman'
];

// ========================================
// UTILITY FUNCTIONS
// ========================================

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickWeighted(items) {
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * totalWeight;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function randomDate(startMonthsAgo, endMonthsAgo = 0) {
  const now = Date.now();
  const start = now - startMonthsAgo * 30 * 24 * 60 * 60 * 1000;
  const end = now - endMonthsAgo * 30 * 24 * 60 * 60 * 1000;
  const ts = start + Math.random() * (end - start);
  return new Date(ts).toISOString().split('T')[0];
}

function randomDateTime(startMonthsAgo, endMonthsAgo = 0) {
  const now = Date.now();
  const start = now - startMonthsAgo * 30 * 24 * 60 * 60 * 1000;
  const end = now - endMonthsAgo * 30 * 24 * 60 * 60 * 1000;
  const ts = start + Math.random() * (end - start);
  return new Date(ts).toISOString();
}

function randomDOB() {
  const age = 35 + Math.floor(Math.random() * 50); // 35-85
  const year = new Date().getFullYear() - age;
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function randomPhone() {
  return `702-${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

// ========================================
// RESOURCE GENERATORS
// ========================================

function generatePatient(id) {
  const given = pick(FIRST_NAMES);
  const family = pick(LAST_NAMES);
  const gender = Math.random() > 0.48 ? 'male' : 'female';

  return {
    resourceType: 'Patient',
    id: `pat-${id}`,
    meta: { lastUpdated: randomDateTime(1) },
    identifier: [{
      system: 'urn:oid:2.16.840.1.113883.3.4886',
      value: `MRN-${String(100000 + id).padStart(7, '0')}`
    }],
    name: [{ use: 'official', family, given: [given] }],
    gender,
    birthDate: randomDOB(),
    address: [{
      line: [`${Math.floor(Math.random() * 9000) + 1000} ${pick(['Desert Inn Rd', 'Flamingo Rd', 'Tropicana Ave', 'Charleston Blvd', 'Sahara Ave', 'Spring Mountain Rd', 'Eastern Ave', 'Decatur Blvd'])}`],
      city: Math.random() > 0.15 ? 'Las Vegas' : pick(['Henderson', 'North Las Vegas', 'Pahrump', 'Boulder City']),
      state: 'NV',
      postalCode: pick(['89101', '89102', '89103', '89104', '89109', '89117', '89119', '89120', '89121', '89123', '89128', '89131', '89134', '89139', '89141', '89146', '89148', '89149', '89048'])
    }],
    telecom: [
      { system: 'phone', value: randomPhone(), use: 'home' }
    ]
  };
}

function generatePractitioner(pract) {
  return {
    resourceType: 'Practitioner',
    id: pract.id,
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: pract.npi }],
    name: [{ use: 'official', prefix: [pract.prefix], given: [pract.given], family: pract.family }],
    qualification: [{ code: { text: pract.specialty } }]
  };
}

function generateLocation(loc) {
  return {
    resourceType: 'Location',
    id: loc.id,
    name: loc.name,
    address: {
      line: [loc.line],
      city: loc.city,
      state: loc.state,
      postalCode: loc.zip
    },
    telecom: [{ system: 'phone', value: '702-803-5534' }]
  };
}

function generateCondition(patientId, practitioner, dx, date, isActive) {
  const cond = {
    resourceType: 'Condition',
    id: `cond-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    clinicalStatus: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: isActive ? 'active' : 'resolved' }]
    },
    category: [{
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }]
    }],
    code: {
      coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: dx.code, display: dx.display }],
      text: dx.display
    },
    subject: { reference: `Patient/${patientId}` },
    onsetDateTime: date,
    recorder: { reference: `Practitioner/${practitioner.id}` }
  };

  if (!isActive) {
    const onsetDate = new Date(date);
    const healDays = 30 + Math.floor(Math.random() * 90);
    const abatement = new Date(onsetDate.getTime() + healDays * 24 * 60 * 60 * 1000);
    if (abatement < new Date()) {
      cond.abatementDateTime = abatement.toISOString().split('T')[0];
    }
  }

  return cond;
}

function generateEncounter(patientId, practitioner, location, date, isNew, cptCodes) {
  // Build type array — AdvancedMD puts CPT codes here
  const typeArray = [];

  // Add each CPT code as a type entry (matching AdvancedMD format)
  if (cptCodes && cptCodes.length > 0) {
    for (const cpt of cptCodes) {
      typeArray.push({
        coding: [{
          system: cpt.code.match(/^[A-Z]/) ? 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets' : 'http://www.ama-assn.org/go/cpt',
          code: cpt.code,
          display: cpt.display
        }],
        text: cpt.display
      });
    }
  }

  return {
    resourceType: 'Encounter',
    id: `enc-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    status: 'finished',
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: 'AMB',
      display: 'ambulatory'
    },
    type: typeArray.length > 0 ? typeArray : [{
      coding: [{ code: isNew ? 'new-patient' : 'follow-up', display: isNew ? 'New Patient Visit' : 'Follow-up Visit' }],
      text: isNew ? 'New Patient Visit' : 'Follow-up Visit'
    }],
    subject: { reference: `Patient/${patientId}` },
    participant: [{
      individual: { reference: `Practitioner/${practitioner.id}`, display: `${practitioner.prefix} ${practitioner.given} ${practitioner.family}` }
    }],
    period: {
      start: `${date}T${String(8 + Math.floor(Math.random() * 8)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
      end: `${date}T${String(9 + Math.floor(Math.random() * 8)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`
    },
    location: [{ location: { reference: `Location/${location.id}`, display: location.name } }]
  };
}

function generateProcedure(patientId, practitioner, procDef, date) {
  return {
    resourceType: 'Procedure',
    id: `proc-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    status: 'completed',
    code: {
      coding: [{
        system: procDef.code.match(/^[A-Z]/) ? 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets' : 'http://www.ama-assn.org/go/cpt',
        code: procDef.code,
        display: procDef.display
      }],
      text: procDef.display
    },
    subject: { reference: `Patient/${patientId}` },
    performedDateTime: `${date}T10:00:00Z`,
    performer: [{ actor: { reference: `Practitioner/${practitioner.id}` } }]
  };
}

function generateServiceRequest(patientId, practitioner, srType, date) {
  return {
    resourceType: 'ServiceRequest',
    id: `sr-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    status: 'active',
    intent: 'order',
    category: [{
      coding: [{ code: srType.category, display: srType.category }]
    }],
    code: {
      text: srType.display
    },
    subject: { reference: `Patient/${patientId}` },
    authoredOn: date,
    requester: { reference: `Practitioner/${practitioner.id}` }
  };
}

function generateMedicationRequest(patientId, practitioner, med, date) {
  return {
    resourceType: 'MedicationRequest',
    id: `medreq-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: {
      coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: med.code, display: med.display }],
      text: med.display
    },
    subject: { reference: `Patient/${patientId}` },
    authoredOn: date,
    requester: { reference: `Practitioner/${practitioner.id}` }
  };
}

function generateCoverage(patientId, carrier) {
  return {
    resourceType: 'Coverage',
    id: `cov-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    status: 'active',
    type: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'HIP' }]
    },
    beneficiary: { reference: `Patient/${patientId}` },
    payor: [{ display: carrier.display }],
    class: [{ type: { text: 'plan' }, value: carrier.display, name: carrier.display }]
  };
}

function generateObservation(patientId, practitioner, date, type) {
  if (type === 'wound-area') {
    const area = (Math.random() * 20 + 0.5).toFixed(1);
    return {
      resourceType: 'Observation',
      id: `obs-${uid()}`,
      meta: { lastUpdated: randomDateTime(1) },
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'exam' }] }],
      code: {
        coding: [{ system: 'http://loinc.org', code: '89260-4', display: 'Wound area' }],
        text: 'Wound area'
      },
      subject: { reference: `Patient/${patientId}` },
      effectiveDateTime: `${date}T10:00:00Z`,
      valueQuantity: { value: parseFloat(area), unit: 'cm2', system: 'http://unitsofmeasure.org', code: 'cm2' },
      performer: [{ reference: `Practitioner/${practitioner.id}` }]
    };
  }

  if (type === 'wound-depth') {
    const depth = (Math.random() * 10 + 0.5).toFixed(1);
    return {
      resourceType: 'Observation',
      id: `obs-${uid()}`,
      meta: { lastUpdated: randomDateTime(1) },
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'exam' }] }],
      code: {
        coding: [{ system: 'http://loinc.org', code: '89261-2', display: 'Wound depth' }],
        text: 'Wound depth'
      },
      subject: { reference: `Patient/${patientId}` },
      effectiveDateTime: `${date}T10:00:00Z`,
      valueQuantity: { value: parseFloat(depth), unit: 'mm', system: 'http://unitsofmeasure.org', code: 'mm' },
      performer: [{ reference: `Practitioner/${practitioner.id}` }]
    };
  }

  // HbA1c
  const hba1c = (5.5 + Math.random() * 5).toFixed(1);
  return {
    resourceType: 'Observation',
    id: `obs-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] }],
    code: {
      coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' }],
      text: 'HbA1c'
    },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: `${date}T10:00:00Z`,
    valueQuantity: { value: parseFloat(hba1c), unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
    performer: [{ reference: `Practitioner/${practitioner.id}` }]
  };
}

function generateDiagnosticReport(patientId, practitioner, date) {
  return {
    resourceType: 'DiagnosticReport',
    id: `dr-${uid()}`,
    meta: { lastUpdated: randomDateTime(1) },
    status: 'final',
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '58410-2', display: 'CBC with Differential' }], text: 'CBC with Differential' },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: `${date}T10:00:00Z`,
    performer: [{ reference: `Practitioner/${practitioner.id}` }]
  };
}

// ========================================
// MAIN GENERATOR
// ========================================

function generateSyntheticData() {
  console.log('\n--- Generating Synthetic FHIR Data ---');
  console.log(`Patients: ${CONFIG.patientCount}`);
  console.log(`Data span: ${CONFIG.monthsOfData} months`);

  const data = {
    patients: [],
    practitioners: [],
    locations: [],
    conditions: [],
    encounters: [],
    procedures: [],
    observations: [],
    serviceRequests: [],
    medicationRequests: [],
    coverages: [],
    diagnosticReports: []
  };

  // Generate practitioners and locations
  data.practitioners = PRACTITIONERS.map(generatePractitioner);
  data.locations = LOCATIONS.map(generateLocation);

  // Generate patients with clinical data
  for (let i = 1; i <= CONFIG.patientCount; i++) {
    const patient = generatePatient(i);
    data.patients.push(patient);

    const patId = patient.id;
    const pract = pick(PRACTITIONERS);
    const loc = pick(LOCATIONS);
    const carrier = pickWeighted(INSURANCE_CARRIERS);

    // Coverage
    data.coverages.push(generateCoverage(patId, carrier));

    // Primary wound diagnosis (1-3 wounds per patient)
    const woundCount = Math.random() < 0.3 ? 2 : Math.random() < 0.1 ? 3 : 1;
    const firstVisitDate = randomDate(CONFIG.monthsOfData, 1);

    for (let w = 0; w < woundCount; w++) {
      const dx = pickWeighted(WOUND_DIAGNOSES);
      const isActive = Math.random() > 0.35;
      const condDate = w === 0 ? firstVisitDate : randomDate(CONFIG.monthsOfData, 0);
      data.conditions.push(generateCondition(patId, pract, dx, condDate, isActive));
    }

    // Comorbidities (0-4 per patient)
    const comorbidityCount = Math.floor(Math.random() * 4);
    const usedComorbidities = new Set();
    for (let c = 0; c < comorbidityCount; c++) {
      const comorbidity = pickWeighted(COMORBIDITIES);
      if (!usedComorbidities.has(comorbidity.code)) {
        usedComorbidities.add(comorbidity.code);
        data.conditions.push(generateCondition(patId, pract, comorbidity, randomDate(24, 6), Math.random() > 0.2));
      }
    }

    // Encounters (2-12 visits over the data period)
    // CPT codes go in Encounter.type (matching AdvancedMD format)
    const visitCount = 2 + Math.floor(Math.random() * 10);
    for (let v = 0; v < visitCount; v++) {
      const visitDate = v === 0 ? firstVisitDate : randomDate(CONFIG.monthsOfData, 0);
      const visitPract = Math.random() > 0.3 ? pract : pick(PRACTITIONERS);
      const isNew = v === 0;

      // Build CPT codes for this encounter
      const encounterCPTs = [];

      // E/M code for each visit
      encounterCPTs.push(pickWeighted(EM_CODES));

      // Debridement on ~60% of visits
      if (Math.random() < 0.6) {
        encounterCPTs.push(pickWeighted(DEBRIDEMENT_PROCEDURES));
      }

      // Surgical procedure on ~8% of visits
      if (Math.random() < 0.08) {
        encounterCPTs.push(pickWeighted(SURGICAL_PROCEDURES));
      }

      // MIST on ~5% of visits
      if (Math.random() < 0.05) {
        encounterCPTs.push(pickWeighted(MIST_PROCEDURES));
      }

      // Compression on ~25% of visits
      if (Math.random() < 0.25) {
        encounterCPTs.push(pickWeighted(COMPRESSION_CODES));
      }

      // Generate encounter with embedded CPT codes
      data.encounters.push(generateEncounter(patId, visitPract, loc, visitDate, isNew, encounterCPTs));

      // Wound measurements on ~70% of visits
      if (Math.random() < 0.7) {
        data.observations.push(generateObservation(patId, visitPract, visitDate, 'wound-area'));
        data.observations.push(generateObservation(patId, visitPract, visitDate, 'wound-depth'));
      }
    }

    // Service requests (2-6 per patient)
    const srCount = 2 + Math.floor(Math.random() * 4);
    for (let s = 0; s < srCount; s++) {
      const srType = pickWeighted(SERVICE_REQUEST_TYPES);
      const srDate = randomDate(CONFIG.monthsOfData, 0);
      data.serviceRequests.push(generateServiceRequest(patId, pract, srType, srDate));
    }

    // Medications (0-4 per patient)
    const medCount = Math.floor(Math.random() * 4);
    for (let m = 0; m < medCount; m++) {
      const med = pickWeighted(MEDICATIONS);
      data.medicationRequests.push(generateMedicationRequest(patId, pract, med, randomDate(CONFIG.monthsOfData, 0)));
    }

    // Lab results on ~40% of patients
    if (Math.random() < 0.4) {
      data.observations.push(generateObservation(patId, pract, randomDate(CONFIG.monthsOfData, 0), 'hba1c'));
      data.diagnosticReports.push(generateDiagnosticReport(patId, pract, randomDate(CONFIG.monthsOfData, 0)));
    }
  }

  // Log summary
  console.log('\nGenerated:');
  for (const [key, arr] of Object.entries(data)) {
    console.log(`  ${key}: ${arr.length}`);
  }

  return data;
}

module.exports = { generateSyntheticData };

// Allow running standalone
if (require.main === module) {
  const data = generateSyntheticData();
  console.log('\nSample Patient:', JSON.stringify(data.patients[0], null, 2));
  console.log('\nSample Condition:', JSON.stringify(data.conditions[0], null, 2));
  console.log('\nSample Encounter:', JSON.stringify(data.encounters[0], null, 2));
}
