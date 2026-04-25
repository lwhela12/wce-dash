#!/usr/bin/env node
/**
 * Create a pseudonymized FHIR Bulk working set for local analysis.
 *
 * Goals:
 * - Preserve resource relationships through deterministic pseudonymous IDs.
 * - Preserve provider names for aggregate provider attribution work.
 * - Remove patient names, identifiers, contact fields, addresses, exact raw dates,
 *   and obvious narrative identifiers.
 * - Shift clinical dates per patient so temporal ordering/intervals remain useful.
 *
 * The output is safer for analysis, but it is not a formal HIPAA determination.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const DEFAULT_INPUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads');
const DEFAULT_OUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads', 'redacted-working-set');

const RESOURCE_PREFIX = {
  Patient: 'pat',
  Encounter: 'enc',
  Condition: 'cond',
  Procedure: 'proc',
  Observation: 'obs',
  DiagnosticReport: 'diag',
  MedicationRequest: 'medreq',
  AllergyIntolerance: 'allergy',
  CarePlan: 'careplan',
  CareTeam: 'careteam',
  Practitioner: 'prac',
  Organization: 'org',
  Location: 'loc',
  Endpoint: 'endpoint',
  Provenance: 'prov'
};

const DATE_KEYS = new Set([
  'date', 'dateTime', 'birthDate', 'lastUpdated', 'recordedDate', 'onsetDateTime',
  'abatementDateTime', 'authoredOn', 'effectiveDateTime', 'issued', 'start', 'end'
]);

const STRIP_KEYS = new Set([
  'identifier', 'telecom', 'address', 'photo', 'signature', 'presentedForm'
]);

function parseArgs(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const options = {
    input: null,
    outDir: path.join(DEFAULT_OUT_ROOT, stamp),
    keepProviderNames: true,
    keepShiftedDates: true
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out-dir') {
      options.outDir = path.resolve(argv[++i]);
    } else if (arg === '--hash-provider-names') {
      options.keepProviderNames = false;
    } else if (arg === '--drop-dates') {
      options.keepShiftedDates = false;
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
  console.log(`Usage: npm run bulk:deidentify-working-set -- [input-dir] [options]

Options:
  --out-dir <path>          Output directory
  --hash-provider-names     Replace provider names too
  --drop-dates              Replace dates instead of patient-specific shifting

Output keeps pseudonymous joins and may still need review before external use.`);
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
  return newestChildDirectory(input);
}

async function readNdjson(filePath, onResource) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
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

function makeSalt() {
  return crypto.randomBytes(32).toString('hex');
}

function digest(salt, value, length = 12) {
  return crypto.createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, length);
}

function pseudonym(state, resourceType, id) {
  if (!id) return null;
  const prefix = RESOURCE_PREFIX[resourceType] || resourceType.toLowerCase();
  return `${prefix}_${digest(state.salt, `${resourceType}/${id}`)}`;
}

function rewriteReference(state, reference) {
  if (typeof reference !== 'string') return reference;
  const match = reference.match(/^([A-Z][A-Za-z]+)\/(.+)$/);
  if (!match) return redactString(state, reference);
  const [, resourceType, id] = match;
  return `${resourceType}/${pseudonym(state, resourceType, id)}`;
}

function fullNameFromHumanName(name) {
  if (!name) return '';
  return `${(name.prefix || []).join(' ')} ${(name.given || []).join(' ')} ${name.family || ''}`
    .replace(/\s+/g, ' ')
    .trim();
}

function collectNameTokens(state, value) {
  if (!value || typeof value !== 'string') return;
  const cleaned = stripHtml(value).replace(/\s+/g, ' ').trim();
  if (cleaned.length >= 3 && cleaned.length <= 120) state.patientNameTokens.add(cleaned);
}

async function collectPatientNames(inputDir, files, state) {
  for (const file of files) {
    const type = typeFromFilename(file);
    if (!['Patient', 'Encounter', 'CareTeam'].includes(type)) continue;
    await readNdjson(file, resource => {
      if (resource.resourceType === 'Patient') {
        for (const name of resource.name || []) {
          collectNameTokens(state, fullNameFromHumanName(name));
          for (const given of name.given || []) collectNameTokens(state, given);
          collectNameTokens(state, name.family);
        }
      }

      if (resource.resourceType === 'Encounter') {
        collectNameTokens(state, resource.subject?.display);
      }

      if (resource.resourceType === 'CareTeam') {
        for (const participant of resource.participant || []) {
          if (participant.member?.reference?.startsWith('Patient/')) {
            collectNameTokens(state, participant.member.display);
          }
        }
      }
    });
  }
}

function stripHtml(value) {
  return String(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildNamePatterns(tokens) {
  const sorted = Array.from(tokens)
    .filter(token => token && token.length >= 3 && token.length <= 120)
    .sort((a, b) => b.length - a.length);
  const patterns = [];
  for (let i = 0; i < sorted.length; i += 500) {
    const chunk = sorted.slice(i, i + 500).map(escapeRegex).join('|');
    patterns.push(new RegExp(`\\b(?:${chunk})\\b`, 'gi'));
  }
  return patterns;
}

function redactString(state, value) {
  let text = stripHtml(value);
  text = text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]')
    .replace(/\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Court|Ct)\b/gi, '[ADDRESS]')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?\b/g, '[DATE]')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '[DATE]')
    .replace(/\b(MRN|Medical Record|Account|Acct|SSN)\s*[:#]?\s*[A-Za-z0-9-]+\b/gi, '$1 [ID]');

  for (const pattern of state.patientNamePatterns || []) {
    text = text.replace(pattern, '[PATIENT_NAME]');
  }

  return text.replace(/\s+/g, ' ').trim();
}

function dateOffsetDays(state, patientId) {
  if (!patientId) return 0;
  const n = parseInt(digest(state.salt, `date-offset/${patientId}`, 8), 16);
  return (n % 730) - 365;
}

function shiftDate(value, offsetDays) {
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
  if (!match) return '[DATE]';
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '[DATE]';
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const shifted = date.toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return `${shifted}T00:00:00Z`;
  return shifted;
}

function patientReference(resource) {
  if (resource.subject?.reference) return resource.subject.reference;
  if (resource.patient?.reference) return resource.patient.reference;
  if (resource.beneficiary?.reference) return resource.beneficiary.reference;
  if (resource.requester?.reference?.startsWith('Patient/')) return resource.requester.reference;
  return null;
}

function patientIdFromReference(reference) {
  if (typeof reference !== 'string') return null;
  const match = reference.match(/^Patient\/(.+)$/);
  return match ? match[1] : null;
}

function patientContextId(resource) {
  if (resource.resourceType === 'Patient') return resource.id;
  return patientIdFromReference(patientReference(resource));
}

function shouldStripKey(resourceType, key) {
  if (STRIP_KEYS.has(key)) return true;
  if (key === 'name' && resourceType === 'Patient') return true;
  if (key === 'text' && resourceType === 'Patient') return true;
  if (key === 'meta') return true;
  return false;
}

function sanitizeResource(state, resource, options) {
  const patientId = patientContextId(resource);
  const offsetDays = dateOffsetDays(state, patientId);

  function sanitize(value, key = '', parentKey = '') {
    if (Array.isArray(value)) return value.map(item => sanitize(item, key, parentKey)).filter(item => item !== undefined);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (shouldStripKey(resource.resourceType, childKey)) {
          state.stripCounts[childKey] = (state.stripCounts[childKey] || 0) + 1;
          continue;
        }
        if (childKey === 'display' && typeof childValue === 'string' && typeof value.reference === 'string') {
          if (value.reference.startsWith('Patient/')) {
            out[childKey] = '[PATIENT]';
            continue;
          }
          if (value.reference.startsWith('Practitioner/')) {
            out[childKey] = childValue;
            continue;
          }
        }
        const clean = sanitize(childValue, childKey, key);
        if (clean !== undefined) out[childKey] = clean;
      }
      return out;
    }

    if (typeof value !== 'string') return value;

    if (key === 'id') return pseudonym(state, resource.resourceType, value);
    if (key === 'reference') return rewriteReference(state, value);
    if (key === 'display' && parentKey === 'subject') return '[PATIENT]';
    if (key === 'display' && parentKey === 'patient') return '[PATIENT]';
    if (resource.resourceType === 'Practitioner' && ['family', 'given', 'prefix', 'suffix', 'text'].includes(key)) {
      return value;
    }

    if (key === 'birthDate') {
      const year = value.match(/^(\d{4})/)?.[1];
      return year ? `${year}-01-01` : '[DATE]';
    }

    if (DATE_KEYS.has(key) || /^\d{4}-\d{2}-\d{2}/.test(value)) {
      if (!options.keepShiftedDates || !patientId) return '[DATE]';
      return shiftDate(value, offsetDays);
    }

    return redactString(state, value);
  }

  const clean = sanitize(resource);
  clean.resourceType = resource.resourceType;
  clean.deidentification = {
    mode: 'pseudonymized-working-set',
    dateHandling: options.keepShiftedDates ? 'patient-specific-shift' : 'dropped'
  };
  return clean;
}

function scanTextForRisks(value, risks, key = '') {
  if (typeof value === 'string') {
    if (['id', 'reference', 'code'].includes(key)) return;
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)) risks.email++;
    if (/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(value)) risks.phone++;
    if (/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(value)) risks.slashDate++;
    if (/\b(?:MRN|Medical Record|Account|Acct|SSN)\s*[:#]?\s*[A-Za-z0-9-]+\b/i.test(value)) risks.identifierLike++;
    if (/\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Court|Ct)\b/i.test(value)) risks.addressLike++;
  } else if (Array.isArray(value)) {
    value.forEach(item => scanTextForRisks(item, risks, key));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, item]) => scanTextForRisks(item, risks, childKey));
  }
}

async function writeRedactedFiles(inputDir, files, state, options) {
  await fsp.mkdir(options.outDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(options.outDir, 0o700);

  const fileSummaries = [];
  const risks = { email: 0, phone: 0, slashDate: 0, identifierLike: 0, addressLike: 0 };

  for (const file of files) {
    const outFile = path.join(options.outDir, path.basename(file));
    const stream = fs.createWriteStream(outFile, { encoding: 'utf8', mode: 0o600 });
    let records = 0;
    await readNdjson(file, resource => {
      const clean = sanitizeResource(state, resource, options);
      scanTextForRisks(clean, risks);
      stream.write(`${JSON.stringify(clean)}\n`);
      records++;
    });
    await new Promise(resolve => stream.end(resolve));
    await fsp.chmod(outFile, 0o600);
    fileSummaries.push({ file: path.basename(file), records });
  }

  return { fileSummaries, risks };
}

function buildReadme(inputDir, options, report) {
  return `# Redacted FHIR Working Set

Generated: ${report.generatedAt}
Input directory: ${inputDir}

This directory contains pseudonymized FHIR NDJSON derived from the local bulk export.

## What Was Preserved

- Resource relationships via pseudonymous \`id\` and \`reference\` values
- Provider names by default
- Clinical codes, code display labels, procedures, diagnoses, medication names, and non-patient aggregate-friendly fields
- Shifted clinical dates using a deterministic patient-specific offset

## What Was Removed Or Redacted

- Patient names
- Raw identifiers
- Telecom/contact fields
- Address fields
- Metadata
- Presented diagnostic attachments
- Obvious emails, phone numbers, addresses, MRN/account/SSN-like strings in narrative text

## Caution

This is a safer working set, not a formal HIPAA de-identification certification.
Review \`deid-risk-report.json\` before external sharing.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputDir = await resolveInput(options.input);
  const files = await findNdjsonFiles(inputDir);
  if (!files.length) throw new Error(`No .ndjson files found in ${inputDir}`);

  const state = {
    salt: makeSalt(),
    patientNameTokens: new Set(),
    stripCounts: {}
  };

  await collectPatientNames(inputDir, files, state);
  state.patientNamePatterns = buildNamePatterns(state.patientNameTokens);
  const { fileSummaries, risks } = await writeRedactedFiles(inputDir, files, state, options);

  const report = {
    generatedAt: new Date().toISOString(),
    inputDirectory: inputDir,
    outputDirectory: options.outDir,
    mode: 'pseudonymized-working-set',
    providerNamesRetained: options.keepProviderNames,
    dateHandling: options.keepShiftedDates ? 'patient-specific deterministic shift' : 'dates dropped',
    files: fileSummaries,
    redaction: {
      patientNameTokensLoaded: state.patientNameTokens.size,
      strippedKeys: state.stripCounts,
      preservedRelationships: true,
      strippedPresentedForms: true
    },
    residualRiskScan: risks,
    caution: 'This working set is safer for local analysis, but it is not a formal HIPAA de-identification determination.'
  };

  await fsp.writeFile(path.join(options.outDir, 'deid-risk-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  await fsp.writeFile(path.join(options.outDir, 'README.md'), buildReadme(inputDir, options, report), { mode: 0o600 });

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: inputDir,
    outputDirectory: options.outDir,
    filesWritten: fileSummaries.length,
    recordsWritten: fileSummaries.reduce((sum, file) => sum + file.records, 0),
    providerNamesRetained: options.keepProviderNames,
    dateHandling: report.dateHandling,
    residualRiskScan: risks,
    reportPath: path.join(options.outDir, 'deid-risk-report.json')
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
