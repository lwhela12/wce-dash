#!/usr/bin/env node
/**
 * Build de-identified dashboard metrics from local FHIR Bulk NDJSON files.
 *
 * Raw FHIR resources are parsed locally and used only to build in-memory joins.
 * The output file contains aggregate metrics only. It does not include patient
 * names, patient IDs, MRNs, DOBs, addresses, telecom values, notes, or exact
 * event dates.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const { deidentify } = require('../deidentify');

const DEFAULT_INPUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads');
const DEFAULT_OUT = path.join(process.cwd(), 'data', 'bulk-dashboard-metrics.json');

const DEBRIDEMENT_CPTS = ['97597', '97598', '97602', '11042', '11043', '11044'];
const SURGICAL_CPTS = ['11042', '11043', '11044', '15271', '15275', '28001'];
const MIST_CPTS = ['0101T', '28220'];
const COMPRESSION_HCPCS = ['A6530', 'A6531', 'A6532', 'A6545'];
const PROCEDURE_DEBRIDEMENT_CODES = new Set([...DEBRIDEMENT_CPTS, '11045', '11046', '11047']);
const PROCEDURE_SKIN_SUBSTITUTE_CODES = new Set(['15271', '15272', '15273', '15274', '15275', '15276', '15277', '15278']);
const PROCEDURE_COMPRESSION_CODES = new Set(['29580', '29445', ...COMPRESSION_HCPCS]);
const PROCEDURE_VASCULAR_CODES = new Set(['93922', '93923', '93924', '93925', '93926', '93930', '93931', '93970', '93971']);
const PROCEDURE_VASCULAR_INTERVENTION_CODES = new Set([
  '36247', '36248', '36465', '36466', '36475', '36476', '36478', '36479',
  '37220', '37221', '37224', '37225', '37226', '37227', '37228', '37229', '37230', '37231',
  '37252', '37253', '75625', '75710'
]);
const PROCEDURE_PODIATRY_CODES = new Set(['11719', '11720', '11721']);
const PROCEDURE_SKIN_LESION_CODES = new Set(['10060', '11104', '11105', '11106', '11107', '17250']);
const PROCEDURE_PREVENTIVE_SCREENING_CODES = new Set(['G0101', 'G0444', 'G8420']);
const PROCEDURE_WOUND_THERAPY_CODES = new Set(['97605', '97606']);
const PROCEDURE_SUPPORT_CODES = new Set(['99152', '99153']);
const PROCEDURE_HOME_VISIT_CODES = new Set(['S9097']);
const PROCEDURE_POSTOP_CODES = new Set(['99024']);
const PROCEDURE_CGM_CODES = new Set(['95249', '95250', '95251']);
const EM_CODES = ['99211', '99212', '99213', '99214', '99215', '99232', '99233'];
const PALLIATIVE_CODES = ['Z51.5'];
const CLOSURE_CODE = 'Z51.89';

const WOUND_ICD10 = {
  DFU: ['E11.621', 'E11.622', 'E11.628', 'E10.621', 'E10.622'],
  VLU: ['I87.2', 'I87.01', 'I87.011', 'I87.012', 'I87.019'],
  PRESSURE: ['L89'],
  ARTERIAL: ['I70.25', 'I70.24', 'I70.23', 'I73.9'],
  SURGICAL: ['T81.31', 'T81.32'],
  TRAUMATIC: ['T14.1', 'T14.8']
};

const WOUND_CATEGORY_NAMES = {
  DFU: 'Diabetic ulcer',
  VLU: 'Venous leg ulcer',
  PRESSURE: 'Pressure injury',
  ARTERIAL: 'Arterial/PVD ulcer',
  SURGICAL: 'Surgical wound',
  TRAUMATIC: 'Traumatic wound'
};

const LAB_CODES = new Set(['laboratory']);
const CULTURE_TEXT = ['culture', 'specimen'];
const PROVIDER_COLORS = ['#2d4a7a', '#d4a732', '#4a7ab5', '#16a34a', '#dc2626', '#6b8db5', '#7c3aed', '#f59e0b'];
const NARRATIVE_THEMES = [
  ['diabetesMedManagement', 'Diabetes medication management', /\b(diabetes|diabetic|a1c|metformin|ozempic|trulicity|jardiance|glipizide|insulin)\b/i],
  ['insulinGlucoseInstruction', 'Insulin or glucose instruction', /\b(insulin|glucose|blood sugar|hypoglycemia|hyperglycemia|units?)\b/i],
  ['woundDressingCare', 'Wound or dressing care', /\b(wound|ulcer|dressing|debridement|compression|offload|graft|drainage|infection)\b/i],
  ['followUpTiming', 'Follow-up timing', /\b(follow up|follow-up|return|recheck|weeks?|months?|days?)\b/i],
  ['referralCoordination', 'Referral or care coordination', /\b(referral|refer|vascular|podiatry|endocrinology|home health|hospice|dme)\b/i],
  ['labResultReview', 'Lab or result review', /\b(lab|culture|result|report|cbc|cmp|albumin|prealbumin|hba1c)\b/i],
  ['smokingLifestyle', 'Smoking or lifestyle', /\b(smoking|smoker|tobacco|diet|nutrition|exercise|weight)\b/i]
];

function parseArgs(argv) {
  const options = { input: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      options.out = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!options.input) {
      options.input = path.resolve(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.input = options.input || DEFAULT_INPUT_ROOT;
  return options;
}

function printUsage() {
  console.log(`Usage: npm run bulk:dashboard -- [input-dir] [--out data/bulk-dashboard-metrics.json]

Builds de-identified aggregate metrics for the dashboard from local FHIR Bulk
NDJSON files. The generated file is safe dashboard data, not raw FHIR data.`);
}

async function newestChildDirectory(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'redacted-working-set') continue;
    const fullPath = path.join(root, entry.name);
    if (!(await findNdjsonFiles(fullPath)).length) continue;
    const stat = await fsp.stat(fullPath);
    dirs.push({ fullPath, mtimeMs: stat.mtimeMs });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs[0]?.fullPath || root;
}

async function findNdjsonFiles(input) {
  const stat = await fsp.stat(input);
  if (stat.isFile()) return input.endsWith('.ndjson') ? [input] : [];
  const entries = await fsp.readdir(input, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.ndjson'))
    .map(entry => path.join(input, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function resolveInput(input) {
  const stat = await fsp.stat(input);
  if (stat.isFile()) return path.dirname(input);
  if ((await findNdjsonFiles(input)).length) return input;
  const newest = await newestChildDirectory(input);
  return newest;
}

async function readNdjsonFile(filePath, onResource) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    count++;
    await onResource(JSON.parse(trimmed));
  }
  return count;
}

function typeFromFilename(filePath) {
  return path.basename(filePath, '.ndjson').replace(/^\d+_/, '');
}

function idFromReference(reference, expectedType = null) {
  if (!reference || typeof reference !== 'string') return null;
  const parts = reference.split('/');
  if (parts.length < 2) return null;
  if (expectedType && parts[0] !== expectedType) return null;
  return parts[parts.length - 1] || null;
}

function allCodings(codeable) {
  if (!codeable) return [];
  if (Array.isArray(codeable)) return codeable.flatMap(allCodings);
  return Array.isArray(codeable.coding) ? codeable.coding : [];
}

function allCodesFromCodeable(codeable) {
  return allCodings(codeable).map(coding => String(coding.code || '')).filter(Boolean);
}

function allDisplayText(codeable) {
  const parts = [];
  if (!codeable) return '';
  if (Array.isArray(codeable)) return codeable.map(allDisplayText).join(' ');
  if (codeable.text) parts.push(codeable.text);
  for (const coding of allCodings(codeable)) {
    if (coding.display) parts.push(coding.display);
    if (coding.code) parts.push(coding.code);
  }
  return parts.join(' ').toLowerCase();
}

function firstPractitionerFromEncounter(encounter) {
  for (const participant of encounter.participant || []) {
    const id = idFromReference(participant.individual?.reference, 'Practitioner');
    if (id) return id;
  }
  return null;
}

function dateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.abs(Math.round((db - da) / 86400000));
}

function differenceInDays(a, b) {
  const da = new Date(`${a}T00:00:00Z`);
  const db = new Date(`${b}T00:00:00Z`);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.abs(Math.round((db - da) / 86400000));
}

function codeStartsWith(code, prefixes) {
  return prefixes.some(prefix => code.startsWith(prefix));
}

function isWoundCode(code) {
  return Object.values(WOUND_ICD10).flat().some(prefix => codeStartsWith(code, [prefix]));
}

function woundTypeName(code) {
  const names = {
    'E11.621': 'Diabetic Foot Ulcer',
    'E11.622': 'Diabetic Skin Ulcer',
    'E11.628': 'Diabetes with Skin Complication',
    'E10.621': 'Type 1 Diabetic Foot Ulcer',
    'E10.622': 'Type 1 Diabetic Skin Ulcer',
    'I87.2': 'Venous Leg Ulcer',
    'I87.01': 'Post-thrombotic VLU',
    'L89': 'Pressure Injury',
    'I70.25': 'Arterial Ulcer',
    'I70.24': 'Arterial Ulcer',
    'I70.23': 'Arterial Ulcer',
    'I73.9': 'Peripheral Vascular Disease',
    'T81.31': 'Surgical Wound Dehiscence',
    'T81.32': 'Surgical Wound Disruption',
    'T14.1': 'Traumatic Wound',
    'T14.8': 'Traumatic Wound'
  };
  for (const [prefix, name] of Object.entries(names)) {
    if (code.startsWith(prefix)) return name;
  }
  return code;
}

function woundCategoryName(code) {
  for (const [category, prefixes] of Object.entries(WOUND_ICD10)) {
    if (codeStartsWith(code, prefixes)) return WOUND_CATEGORY_NAMES[category] || category;
  }
  return 'Other wound diagnosis';
}

function procedureCategoryForProcedure(proc) {
  const codes = allCodesFromCodeable(proc.code).map(code => code.toUpperCase());
  const text = allDisplayText(proc.code);
  const hasCode = set => codes.some(code => set.has(code));

  if (hasCode(PROCEDURE_DEBRIDEMENT_CODES) || /\bdebrid(e|ement|ed|ing)\b/.test(text)) return 'Debridement';
  if (hasCode(PROCEDURE_COMPRESSION_CODES) || /\b(compression|unna|wrap|strapping|total contact cast)\b/.test(text)) return 'Compression / wrap';
  if (hasCode(PROCEDURE_VASCULAR_CODES) || /\b(abi|arterial|vascular|venous|duplex|ultrasound|reflux)\b/.test(text)) return 'Vascular testing';
  if (hasCode(PROCEDURE_VASCULAR_INTERVENTION_CODES) || /\b(endovenous|ablation|varithena|angiography|aortography|revasc|atherectomy|ivus|catheter|cath|tib\/per|fem\/popl)\b/.test(text)) return 'Vascular intervention';
  if (hasCode(PROCEDURE_SKIN_SUBSTITUTE_CODES) || /\b(skin substitute|graft|application of skin|cellular tissue)\b/.test(text)) return 'Skin substitute / graft';
  if (hasCode(PROCEDURE_WOUND_THERAPY_CODES) || /\bnegative pressure wound therapy\b/.test(text)) return 'Negative pressure therapy';
  if (hasCode(PROCEDURE_PODIATRY_CODES) || /\b(nail|mycotic|paring|hyperkeratotic|benign lesion)\b/.test(text)) return 'Podiatry / nail care';
  if (hasCode(PROCEDURE_SKIN_LESION_CODES) || /\b(silver nitrate|chemical cautery|i&d abscess|incisional biopsy|punch biopsy)\b/.test(text)) return 'Minor skin procedure';
  if (hasCode(PROCEDURE_PREVENTIVE_SCREENING_CODES) || /\b(bmi documentation|screen for depression|cervical or vaginal cancer screen)\b/.test(text)) return 'Preventive screening';
  if (hasCode(PROCEDURE_SUPPORT_CODES) || /\b(sedation)\b/.test(text)) return 'Procedure support';
  if (hasCode(PROCEDURE_HOME_VISIT_CODES) || /\bhome visit\b/.test(text)) return 'Home visit';
  if (hasCode(PROCEDURE_POSTOP_CODES) || /\b(post[- ]?op|postoperative)\b/.test(text)) return 'Post-op follow-up';
  if (hasCode(PROCEDURE_CGM_CODES) || /\b(cgm|continuous glucose)\b/.test(text)) return 'CGM interpretation';
  if (codes.some(code => MIST_CPTS.includes(code)) || /\b(mist|ultrasonic)\b/.test(text)) return 'MIST / ultrasonic';
  return 'Other procedure records';
}

function emptyProvider(id, practitioner = {}) {
  const name = practitioner.name || `Provider ${id || 'Unknown'}`;
  return {
    id,
    name,
    initials: practitioner.initials || initialsFromName(name),
    specialty: practitioner.specialty || 'Unknown',
    role: practitioner.role || practitioner.specialty || 'Provider',
    activeWounds: 0,
    healingRate: 0,
    avgDays: 0,
    visitCompliance: 0,
    woundsTreated: 0,
    healed: 0,
    debrideRate: 0,
    compressionVLU: 0,
    weeklyVisit: 0,
    ptsOver16w: 0,
    palliativePts: 0,
    abiOrders: 0,
    abiOrders30d: 0,
    venousUS: 0,
    venousUS30d: 0,
    arterialUS: 0,
    arterialUS30d: 0,
    labOrders: 0,
    labOrders30d: 0,
    cultureOrders: 0,
    cultureOrders30d: 0,
    endoRef: 0,
    vascRef: 0,
    podRef: 0,
    dmeOrders: 0,
    rxWritten: 0,
    radiologyOrders: 0,
    hospiceRef: 0,
    erSends: 0,
    newPatients: 0,
    followupPatients: 0,
    mistOrders: 0,
    z5189Count: 0,
    weeklyVolume: 0,
    monthlyVolume: 0,
    compressionCodes: Object.fromEntries(COMPRESSION_HCPCS.map(code => [code, 0])),
    debridementCPT: Object.fromEntries(DEBRIDEMENT_CPTS.map(code => [code, 0])),
    surgicalCPT: Object.fromEntries(SURGICAL_CPTS.map(code => [code, 0])),
    emCodes: Object.fromEntries(EM_CODES.map(code => [code, 0])),
    debridementsPerWound: 0,
    compressionPerWound: 0,
    surgicalPerWound: 0,
    emPerWound: 0,
    mistPerWound: 0,
    labsPerWound: 0,
    culturesPerWound: 0,
    abiPerWound: 0,
    referralsPerWound: 0,
    unresolvedWounds: 0,
    providerInsights: {
      directEncounters: 0,
      directProcedures: 0,
      directDiagnosticReports: 0,
      directMedicationInstructions: 0,
      inferredDiagnosesSameDay: 0,
      inferredDiagnosesWithin7d: 0,
      inferredNoteThemesSameDay: 0,
      inferredNoteThemesWithin7d: 0,
      inferredObservationsSameDay: 0,
      inferredObservationsWithin7d: 0,
      diagnosisMix: {},
      diagnosisCategories: {},
      procedureCategories: {},
      diagnosticCategories: {},
      narrativeThemes: {}
    },
    _patients: new Set(),
    _woundPatients: new Set(),
    _activeWoundPatients: new Set(),
    _healedPatients: new Set(),
    _diagnosticEncounterIds: new Set(),
    _healDays: [],
    _encounterDates: []
  };
}

function initialsFromName(name) {
  return String(name || '')
    .replace(/,\s*(MD|DO|DPM|APRN|NP|PA|FNP)\b/gi, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() || '')
    .join('') || '?';
}

function titleCaseName(value) {
  return String(value || '')
    .toLowerCase()
    .split(/(\s+|-)/)
    .map(part => /^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part)
    .join('')
    .replace(/\bIi\b/g, 'II')
    .replace(/\bIii\b/g, 'III')
    .replace(/\bIv\b/g, 'IV');
}

function providerCredential(name) {
  const prefix = (name?.prefix || []).join(' ').trim();
  const suffix = (name?.suffix || []).join(' ').trim();
  return [prefix, suffix].join(' ').match(/\b(MD|DO|DPM|APRN|NP|PA|FNP)\b/i)?.[1]?.toUpperCase() || '';
}

function providerDisplayName(name, fallback) {
  if (!name) return fallback;
  const credential = providerCredential(name);
  const lastName = (name.given || []).join(' ').replace(/\s+/g, ' ').trim();
  const firstName = String(name.family || '').replace(/\s+/g, ' ').trim();
  const personName = [firstName, lastName].filter(Boolean).map(titleCaseName).join(' ');
  return [personName || fallback, credential].filter(Boolean).join(', ');
}

function practitionerSummary(resource) {
  const name = resource.name?.[0];
  const fullName = providerDisplayName(name, `Provider ${resource.id}`);
  return {
    id: resource.id,
    name: fullName,
    initials: initialsFromName(fullName),
    specialty: resource.qualification?.[0]?.code?.text || 'Provider',
    role: resource.qualification?.[0]?.code?.text || 'Provider'
  };
}

function ensureProvider(state, providerId) {
  if (!providerId) return null;
  if (!state.providers.has(providerId)) {
    state.providers.set(providerId, emptyProvider(providerId, state.practitioners.get(providerId)));
  }
  return state.providers.get(providerId);
}

function addCodesToProvider(stats, codes) {
  for (const code of codes) {
    if (stats.emCodes[code] !== undefined) stats.emCodes[code]++;
    if (stats.debridementCPT[code] !== undefined) stats.debridementCPT[code]++;
    if (stats.surgicalCPT[code] !== undefined) stats.surgicalCPT[code]++;
    if (stats.compressionCodes[code] !== undefined) stats.compressionCodes[code]++;
    if (MIST_CPTS.includes(code)) stats.mistOrders++;
  }
}

function providerForPatient(state, patientId) {
  if (!patientId) return null;
  return state.patientPrimaryProvider.get(patientId) || null;
}

function providerForEncounter(state, encounterRef) {
  const encounterId = idFromReference(encounterRef, 'Encounter');
  return encounterId ? state.encounters.get(encounterId)?.providerId || null : null;
}

function patientDateProviderMatch(state, patientId, eventDate, maxDays = 7) {
  if (!patientId || !eventDate) return null;
  const eventDay = dateOnly(eventDate);
  if (!eventDay) return null;
  const encounters = state.patientEncounters.get(patientId) || [];

  const sameDayProviders = new Set(encounters
    .filter(encounter => encounter.date === eventDay)
    .map(encounter => encounter.providerId)
    .filter(Boolean));
  if (sameDayProviders.size === 1) {
    return { providerId: [...sameDayProviders][0], confidence: 'same-day' };
  }

  const nearProviders = new Set();
  for (const encounter of encounters) {
    const diff = differenceInDays(encounter.date, eventDay);
    if (diff !== null && diff <= maxDays && encounter.providerId) nearProviders.add(encounter.providerId);
  }
  if (nearProviders.size === 1) {
    return { providerId: [...nearProviders][0], confidence: 'within-7d' };
  }

  return null;
}

function recordAttribution(state, kind, confidence) {
  if (!state.attributionQuality[kind]) {
    state.attributionQuality[kind] = { total: 0, direct: 0, sameDay: 0, within7d: 0, unattributed: 0 };
  }
  state.attributionQuality[kind].total++;
  if (confidence === 'direct') state.attributionQuality[kind].direct++;
  else if (confidence === 'same-day') state.attributionQuality[kind].sameDay++;
  else if (confidence === 'within-7d') state.attributionQuality[kind].within7d++;
  else state.attributionQuality[kind].unattributed++;
}

function incrementInsight(stats, key, amount = 1) {
  if (!stats?.providerInsights) return;
  stats.providerInsights[key] = (stats.providerInsights[key] || 0) + amount;
}

function addCount(object, key, amount = 1) {
  object[key] = (object[key] || 0) + amount;
}

function topEntries(object, limit = 6) {
  return Object.entries(object || {})
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function classifyNarrativeThemes(text) {
  if (!text) return [];
  const themes = [];
  for (const [, label, pattern] of NARRATIVE_THEMES) {
    if (pattern.test(text)) themes.push({ label });
  }
  return themes.length ? themes : [{ label: 'Other clinical text' }];
}

function classifyDiagnosticOrObservation(resource) {
  const categoryCodes = (resource.category || []).flatMap(category => allCodesFromCodeable(category));
  const text = [
    allDisplayText(resource.code),
    ...(resource.category || []).map(allDisplayText)
  ].join(' ');
  return {
    isLab: categoryCodes.some(code => LAB_CODES.has(code)) || /\b(lab|cbc|cmp|albumin|prealbumin|hba1c|hemoglobin|glucose|calcium)\b/.test(text),
    isCulture: CULTURE_TEXT.some(pattern => text.includes(pattern))
  };
}

function diagnosticPurposeCategories(resource) {
  const text = [
    allDisplayText(resource.code),
    ...(resource.category || []).map(allDisplayText)
  ].join(' ').toLowerCase();
  const categories = [];

  if (/(hba1c|a1c|glucose|diabetes|glycemic)/.test(text)) categories.push('Diabetes / glycemic monitoring');
  if (/(bun|creat|egfr|microalbumin|sodium|potassium|chloride|carbon dioxide|co2|calcium|metabolic|cmp)/.test(text)) categories.push('Renal / metabolic panel');
  if (/(albumin|prealbumin|protein|prot |globulin|nutrition)/.test(text)) categories.push('Nutrition / healing status');
  if (/(wbc|rbc|hgb|hct|hemoglobin|hematocrit|platelet|platelets|neutrophil|lymphocyte|lymphs|monocyte|eosinophil|basophil|basos|eos |mcv|mch|mchc|rdw|nrbc|pmv|cbc|blood count|hematology|crp|esr)/.test(text)) categories.push('CBC / infection screen');
  if (/(ast|alt|alp|alkaline phosphatase|bilirub|bilirubin|liver|hepatic)/.test(text)) categories.push('Liver function');
  if (/(cholest|hdl|ldl|nonhdl|trigl|lipid)/.test(text)) categories.push('Lipid / cardiometabolic risk');
  if (/(culture|cult|specimen|microbiology|bacteria)/.test(text)) categories.push('Culture / microbiology');
  if (/(tsh|thyroid|t4 |t4 free)/.test(text)) categories.push('Thyroid / endocrine monitoring');
  if (/(vitamin d|25\\(oh\\)d|25ohd|ferritin|iron|b12|folate)/.test(text)) categories.push('Vitamin / mineral status');
  if (/\b(blood pressure|body weight|body height|bmi|heart rate|temperature|respiratory rate|oxygen saturation|pulse oximetry|vital)\b/.test(text)) categories.push('Vitals / body measures');
  if (/\b(referral note|nurse note|clinical note)\b/.test(text)) categories.push('Clinical/referral note');

  return categories.length ? categories : ['Other lab/report activity'];
}

async function loadResourceFiles(inputDir, state) {
  const files = await findNdjsonFiles(inputDir);
  state.files = files.map(file => path.basename(file));
  state.resourceCounts = {};

  const filesByType = new Map(files.map(file => [typeFromFilename(file), file]));

  if (filesByType.has('Practitioner')) {
    state.resourceCounts.Practitioner = await readNdjsonFile(filesByType.get('Practitioner'), resource => {
      state.practitioners.set(resource.id, practitionerSummary(resource));
    });
  }

  if (filesByType.has('Location')) {
    state.resourceCounts.Location = await readNdjsonFile(filesByType.get('Location'), resource => {
      state.locations.set(resource.id, {
        id: resource.id,
        name: resource.name || 'Unknown',
        city: resource.address?.city || '',
        state: resource.address?.state || '',
        zip: resource.address?.postalCode || ''
      });
    });
  }

  if (filesByType.has('Encounter')) {
    state.resourceCounts.Encounter = await readNdjsonFile(filesByType.get('Encounter'), resource => processEncounter(state, resource));
    calculatePatientPrimaryProviders(state);
  }

  for (const [type, processor] of [
    ['Condition', processCondition],
    ['CarePlan', processCarePlan],
    ['Procedure', processProcedure],
    ['MedicationRequest', processMedicationRequest],
    ['Observation', processObservation],
    ['DiagnosticReport', processDiagnosticReport]
  ]) {
    if (filesByType.has(type)) {
      state.resourceCounts[type] = await readNdjsonFile(filesByType.get(type), resource => processor(state, resource));
    }
  }

  for (const [type, file] of filesByType.entries()) {
    if (state.resourceCounts[type] !== undefined) continue;
    state.resourceCounts[type] = await readNdjsonFile(file, () => {});
  }
}

function processEncounter(state, enc) {
  const patientId = idFromReference(enc.subject?.reference, 'Patient');
  const providerId = firstPractitionerFromEncounter(enc);
  const locationId = idFromReference(enc.location?.[0]?.location?.reference, 'Location');
  const date = enc.period?.start || enc.meta?.lastUpdated;
  const codes = (enc.type || []).flatMap(type => allCodesFromCodeable(type));

  if (enc.id) state.encounters.set(enc.id, { id: enc.id, patientId, providerId, locationId, date, codes });
  const encounterDay = dateOnly(date);
  if (patientId && providerId && encounterDay) {
    if (!state.patientEncounters.has(patientId)) state.patientEncounters.set(patientId, []);
    state.patientEncounters.get(patientId).push({ date: encounterDay, providerId, encounterId: enc.id });
  }
  if (patientId && providerId) {
    if (!state.patientProviderVisits.has(patientId)) state.patientProviderVisits.set(patientId, new Map());
    const providerVisits = state.patientProviderVisits.get(patientId);
    providerVisits.set(providerId, (providerVisits.get(providerId) || 0) + 1);
  }

  const stats = ensureProvider(state, providerId);
  if (!stats) return;

  incrementInsight(stats, 'directEncounters');
  if (date) stats._encounterDates.push(date);
  if (patientId) stats._patients.add(patientId);
  addCodesToProvider(stats, codes);

  const displayText = (enc.type || []).map(allDisplayText).join(' ');
  const dispositionText = allDisplayText(enc.hospitalization?.dischargeDisposition);
  if (displayText.includes('emergency') || dispositionText.includes('emergency') || dispositionText.includes('er')) {
    stats.erSends++;
  }
}

function calculatePatientPrimaryProviders(state) {
  for (const [patientId, providerVisits] of state.patientProviderVisits.entries()) {
    let bestProvider = null;
    let bestCount = -1;
    for (const [providerId, count] of providerVisits.entries()) {
      if (count > bestCount) {
        bestProvider = providerId;
        bestCount = count;
      }
    }
    if (bestProvider) state.patientPrimaryProvider.set(patientId, bestProvider);
  }
}

function processCondition(state, cond) {
  const patientId = idFromReference(cond.subject?.reference, 'Patient');
  const eventDate = cond.recordedDate || cond.onsetDateTime || cond.abatementDateTime;
  const attribution = patientDateProviderMatch(state, patientId, eventDate);
  const inferredStats = ensureProvider(state, attribution?.providerId);
  const providerId = providerForPatient(state, patientId);
  const stats = ensureProvider(state, providerId);
  const codes = allCodesFromCodeable(cond.code);
  const clinical = (cond.clinicalStatus?.coding || []).map(coding => coding.code).join(' ');
  const isActive = clinical.includes('active');
  const isResolved = clinical.includes('resolved') || Boolean(cond.abatementDateTime);

  for (const code of codes) {
    state.diagnosisCounts.set(code, (state.diagnosisCounts.get(code) || 0) + 1);
    if (attribution && inferredStats && isWoundCode(code)) {
      if (attribution.confidence === 'same-day') incrementInsight(inferredStats, 'inferredDiagnosesSameDay');
      if (attribution.confidence === 'within-7d') incrementInsight(inferredStats, 'inferredDiagnosesWithin7d');
      addCount(inferredStats.providerInsights.diagnosisMix, `${woundTypeName(code)} (${code})`);
      addCount(inferredStats.providerInsights.diagnosisCategories, woundCategoryName(code));
    }
    if (!stats) continue;
    if (code === CLOSURE_CODE) stats.z5189Count++;
    if (PALLIATIVE_CODES.includes(code)) stats.palliativePts++;
    if (!isWoundCode(code)) continue;

    stats.woundsTreated++;
    if (patientId) stats._woundPatients.add(patientId);
    if (isActive && patientId) stats._activeWoundPatients.add(patientId);
    if (isResolved && patientId) stats._healedPatients.add(patientId);
    if (isResolved) stats.healed++;

    const start = cond.onsetDateTime || cond.recordedDate;
    const end = cond.abatementDateTime;
    const healDays = start && end ? daysBetween(start, end) : null;
    if (healDays !== null) stats._healDays.push(healDays);

    if (isActive && start && daysBetween(start, new Date()) > 112) {
      stats.ptsOver16w++;
    }
  }

  recordAttribution(state, 'diagnoses', attribution?.confidence);
}

function processCarePlan(state, carePlan) {
  const text = carePlan.text?.div;
  if (!text) return;

  const patientId = idFromReference(carePlan.subject?.reference, 'Patient');
  const eventDate = carePlan.period?.start || carePlan.created || carePlan.modified;
  const attribution = patientDateProviderMatch(state, patientId, eventDate);
  const stats = ensureProvider(state, attribution?.providerId);
  recordAttribution(state, 'noteThemes', attribution?.confidence);
  if (!stats || !attribution) return;

  if (attribution.confidence === 'same-day') incrementInsight(stats, 'inferredNoteThemesSameDay');
  if (attribution.confidence === 'within-7d') incrementInsight(stats, 'inferredNoteThemesWithin7d');
  for (const theme of classifyNarrativeThemes(text)) {
    addCount(stats.providerInsights.narrativeThemes, theme.label);
  }
}

function processProcedure(state, proc) {
  const directProviderId = providerForEncounter(state, proc.encounter?.reference);
  const providerId = directProviderId || providerForPatient(state, idFromReference(proc.subject?.reference, 'Patient'));
  const stats = ensureProvider(state, providerId);
  if (!stats) return;
  if (directProviderId) {
    incrementInsight(stats, 'directProcedures');
    addCount(stats.providerInsights.procedureCategories, procedureCategoryForProcedure(proc));
  }
  addCodesToProvider(stats, allCodesFromCodeable(proc.code));
}

function processMedicationRequest(state, med) {
  const directProviderId = providerForEncounter(state, med.encounter?.reference);
  const providerId = directProviderId ||
    idFromReference(med.requester?.reference, 'Practitioner') ||
    providerForPatient(state, idFromReference(med.subject?.reference, 'Patient'));
  const stats = ensureProvider(state, providerId);
  if (!stats) return;
  stats.rxWritten++;
  const hasInstructionText = (med.dosageInstruction || []).some(dose => dose.text);
  if (directProviderId && hasInstructionText) incrementInsight(stats, 'directMedicationInstructions');
  for (const dose of med.dosageInstruction || []) {
    for (const theme of classifyNarrativeThemes(dose.text)) {
      addCount(stats.providerInsights.narrativeThemes, theme.label);
    }
  }
}

function processObservation(state, obs) {
  const directProviderId = providerForEncounter(state, obs.encounter?.reference);
  const patientId = idFromReference(obs.subject?.reference, 'Patient');
  const attribution = directProviderId
    ? { providerId: directProviderId, confidence: 'direct' }
    : patientDateProviderMatch(state, patientId, obs.effectiveDateTime || obs.issued);
  const providerId = attribution?.providerId || providerForPatient(state, patientId);
  const stats = ensureProvider(state, providerId);
  if (!stats) return;
  recordAttribution(state, 'observations', attribution?.confidence);
  if (attribution?.confidence === 'same-day') incrementInsight(stats, 'inferredObservationsSameDay');
  if (attribution?.confidence === 'within-7d') incrementInsight(stats, 'inferredObservationsWithin7d');
  const classification = classifyDiagnosticOrObservation(obs);
  if (classification.isLab) stats.labOrders++;
  if (classification.isCulture) stats.cultureOrders++;
  for (const category of diagnosticPurposeCategories(obs)) {
    addCount(stats.providerInsights.diagnosticCategories, category);
  }
}

function processDiagnosticReport(state, report) {
  const directProviderId = providerForEncounter(state, report.encounter?.reference);
  const providerId = directProviderId || providerForPatient(state, idFromReference(report.subject?.reference, 'Patient'));
  const stats = ensureProvider(state, providerId);
  if (!stats) return;
  if (directProviderId) {
    incrementInsight(stats, 'directDiagnosticReports');
    const encounterId = idFromReference(report.encounter?.reference, 'Encounter');
    if (encounterId) stats._diagnosticEncounterIds.add(encounterId);
  }
  const classification = classifyDiagnosticOrObservation(report);
  if (classification.isLab) stats.labOrders++;
  if (classification.isCulture) stats.cultureOrders++;
  for (const category of diagnosticPurposeCategories(report)) {
    addCount(stats.providerInsights.diagnosticCategories, category);
  }
}

function finalizeProviders(state) {
  const providers = groupProviderStats([...state.providers.values()])
    .filter(provider => provider._encounterDates.length || provider.woundsTreated || totalCodeCount(provider) || provider.rxWritten || provider.labOrders)
    .sort((a, b) => b._encounterDates.length - a._encounterDates.length)
    .map((stats, i) => {
      stats.color = PROVIDER_COLORS[i % PROVIDER_COLORS.length];
      stats.newPatients = stats._patients.size;
      stats.followupPatients = Math.max(0, stats._encounterDates.length - stats._patients.size);
      stats.activeWounds = stats._activeWoundPatients.size || stats.activeWounds;
      stats.healed = stats._healedPatients.size || stats.healed;
      stats.healingRate = stats.woundsTreated ? Math.round((stats.healed / stats.woundsTreated) * 100) : 0;
      if (stats._healDays.length) {
        stats.avgDays = Math.round(stats._healDays.reduce((sum, days) => sum + days, 0) / stats._healDays.length);
      }

      if (stats._encounterDates.length) {
        const dates = stats._encounterDates.map(date => new Date(date)).filter(date => !Number.isNaN(date.getTime())).sort((a, b) => a - b);
        if (dates.length) {
          const spanDays = Math.max(1, Math.round((dates[dates.length - 1] - dates[0]) / 86400000));
          const spanWeeks = Math.max(1, spanDays / 7);
          const spanMonths = Math.max(1, spanDays / 30.44);
          stats.weeklyVolume = Math.round(dates.length / spanWeeks);
          stats.weeklyVisit = stats.weeklyVolume;
          stats.monthlyVolume = Math.round(dates.length / spanMonths);
        }
      }

      const woundDenominator = Math.max(1, stats.woundsTreated || stats._woundPatients.size || stats._patients.size);
      const totalDebridements = sumObject(stats.debridementCPT);
      const totalCompression = sumObject(stats.compressionCodes);
      const totalSurgical = sumObject(stats.surgicalCPT);
      const totalEm = sumObject(stats.emCodes);

      stats.debrideRate = Math.round((totalDebridements / woundDenominator) * 100);
      stats.debridementsPerWound = round1(totalDebridements / woundDenominator);
      stats.compressionPerWound = round1(totalCompression / woundDenominator);
      stats.surgicalPerWound = round1(totalSurgical / woundDenominator);
      stats.emPerWound = round1(totalEm / woundDenominator);
      stats.mistPerWound = round2(stats.mistOrders / woundDenominator);
      stats.labsPerWound = round1(stats.labOrders / woundDenominator);
      stats.culturesPerWound = round1(stats.cultureOrders / woundDenominator);
      stats.abiPerWound = round2(stats.abiOrders / woundDenominator);
      stats.referralsPerWound = round2((stats.endoRef + stats.vascRef + stats.podRef) / woundDenominator);
      stats.compressionVLU = totalCompression;
      stats.unresolvedWounds = Math.max(0, stats.activeWounds - stats.healed);
      stats.providerInsights.diagnosisMix = topEntries(stats.providerInsights.diagnosisMix);
      stats.providerInsights.diagnosisCategories = topEntries(stats.providerInsights.diagnosisCategories);
      stats.providerInsights.procedureCategories = topEntries(stats.providerInsights.procedureCategories, 10);
      stats.providerInsights.diagnosticCategories = topEntries(stats.providerInsights.diagnosticCategories, 9);
      stats.providerInsights.narrativeThemes = topEntries(stats.providerInsights.narrativeThemes);
      stats.providerInsights.inferredDiagnoses = stats.providerInsights.inferredDiagnosesSameDay + stats.providerInsights.inferredDiagnosesWithin7d;
      stats.providerInsights.inferredNoteThemes = stats.providerInsights.inferredNoteThemesSameDay + stats.providerInsights.inferredNoteThemesWithin7d;
      stats.providerInsights.inferredObservations = stats.providerInsights.inferredObservationsSameDay + stats.providerInsights.inferredObservationsWithin7d;
      stats.providerInsights.directDiagnosticResultRows = stats.providerInsights.directDiagnosticReports;
      stats.providerInsights.directDiagnosticEncounters = stats._diagnosticEncounterIds.size;

      delete stats._patients;
      delete stats._woundPatients;
      delete stats._activeWoundPatients;
      delete stats._healedPatients;
      delete stats._diagnosticEncounterIds;
      delete stats._healDays;
      delete stats._encounterDates;
      return stats;
    });

  return providers;
}

function totalCodeCount(provider) {
  return sumObject(provider.debridementCPT) + sumObject(provider.surgicalCPT) + sumObject(provider.emCodes) + sumObject(provider.compressionCodes);
}

function groupProviderStats(providers) {
  const groups = new Map();
  for (const provider of providers) {
    const key = provider.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim() || provider.id;

    if (!groups.has(key)) {
      provider.id = key.replace(/\s+/g, '-');
      groups.set(key, provider);
      continue;
    }

    mergeProvider(groups.get(key), provider);
  }
  return [...groups.values()];
}

function mergeProvider(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (['id', 'name', 'initials', 'specialty', 'role', 'color'].includes(key)) continue;
    if (key === 'providerInsights') {
      mergeProviderInsights(target.providerInsights, value);
      continue;
    }
    if (value instanceof Set) {
      for (const item of value) target[key].add(item);
    } else if (Array.isArray(value)) {
      target[key].push(...value);
    } else if (value && typeof value === 'object') {
      for (const [subKey, subValue] of Object.entries(value)) {
        target[key][subKey] = (target[key][subKey] || 0) + Number(subValue || 0);
      }
    } else if (typeof value === 'number') {
      target[key] = (target[key] || 0) + value;
    }
  }
}

function mergeProviderInsights(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      for (const [subKey, subValue] of Object.entries(value)) {
        target[key][subKey] = (target[key][subKey] || 0) + Number(subValue || 0);
      }
    } else if (typeof value === 'number') {
      target[key] = (target[key] || 0) + value;
    }
  }
}

function sumObject(object) {
  return Object.values(object || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function buildDiagnoses(state) {
  return [...state.diagnosisCounts.entries()]
    .filter(([code]) => isWoundCode(code))
    .map(([code, count], i) => ({
      code,
      name: woundTypeName(code),
      count,
      color: PROVIDER_COLORS[i % PROVIDER_COLORS.length]
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

function buildMetrics(state, inputDir) {
  const providers = finalizeProviders(state);
  const metrics = {
    providers,
    diagnoses: buildDiagnoses(state),
    locations: [...state.locations.values()],
    insurance: [],
    summary: {
      totalPatients: state.resourceCounts.Patient || state.patientPrimaryProvider.size,
      totalEncounters: state.resourceCounts.Encounter || 0,
      totalConditions: state.resourceCounts.Condition || 0,
      totalProcedures: state.resourceCounts.Procedure || 0,
      totalProviders: providers.length,
      dataSource: 'AdvancedMD FHIR Bulk NDJSON',
      generatedFrom: path.basename(inputDir),
      sourceFreshness: 'local-bulk-download',
      attributionQuality: state.attributionQuality,
      unsupportedMetrics: [
        'payer mix: Coverage resources were not present in this bulk export',
        'orders/referrals: ServiceRequest resources were not present in this bulk export',
        'lab activity: DiagnosticReport/Observation activity is available, but actual lab orders need ServiceRequest',
        'healing rate: inferred from condition status/abatement only until WCE closure coding is mapped'
      ],
      resourceCounts: state.resourceCounts
    }
  };

  return deidentify(metrics);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputDir = await resolveInput(options.input);
  const state = {
    files: [],
    resourceCounts: {},
    practitioners: new Map(),
    locations: new Map(),
    providers: new Map(),
    encounters: new Map(),
    patientProviderVisits: new Map(),
    patientEncounters: new Map(),
    patientPrimaryProvider: new Map(),
    diagnosisCounts: new Map(),
    attributionQuality: {}
  };

  await loadResourceFiles(inputDir, state);
  const data = buildMetrics(state, inputDir);
  const payload = {
    generatedAt: new Date().toISOString(),
    dataSource: 'local-bulk-dashboard',
    inputDirectory: inputDir,
    phiStatus: 'aggregate-only; raw FHIR values excluded from output',
    data
  };

  await fsp.mkdir(path.dirname(options.out), { recursive: true });
  await fsp.writeFile(options.out, JSON.stringify(payload, null, 2), { mode: 0o600 });

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: inputDir,
    outputPath: options.out,
    dataSource: payload.dataSource,
    providers: data.providers.length,
    patients: data.summary.totalPatients,
    encounters: data.summary.totalEncounters,
    conditions: data.summary.totalConditions,
    procedures: data.summary.totalProcedures,
    diagnoses: data.diagnoses.length,
    unsupportedMetrics: data.summary.unsupportedMetrics
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
