#!/usr/bin/env node
/**
 * Unlinked narrative signal analysis for local FHIR Bulk NDJSON.
 *
 * This script extracts narrative-ish text fields, drops all resource linkage,
 * redacts obvious identifiers, classifies text into aggregate themes, and writes
 * local review artifacts. It does not print narrative samples to stdout.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const DEFAULT_INPUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads');
const DEFAULT_OUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads');
const DEFAULT_MAX_EXAMPLES = 8;
const DEFAULT_MAX_CHARS = 500;

const NARRATIVE_PATHS = new Set([
  'CarePlan.text.div',
  'MedicationRequest.dosageInstruction[].text',
  'DiagnosticReport.presentedForm[].data',
  'Patient.text.div'
]);

const THEME_RULES = [
  ['diabetes_med_management', /\b(diabetes|diabetic|glucose|blood sugar|a1c|hba1c|insulin|lantus|humalog|metformin|jardiance|repaglinide|sliding scale|hypoglycemia|hyperglycemia)\b/i],
  ['insulin_or_glucose_instruction', /\b(insulin|lantus|humalog|sliding scale|blood sugar|glucose|hypoglycemia|skip a meal|before meals?)\b/i],
  ['medication_dosing_instruction', /\b(\d+\s*(mg|mcg|units?|tabs?|tablets?|capsules?)|take|start|stop|increase|decrease|continue|hold|refill|daily|bid|tid|qid|before meals?|after meals?)\b/i],
  ['follow_up_timing', /\b(follow[- ]?up|return|next appointment|in \d+\s*(day|days|week|weeks|month|months)|recheck)\b/i],
  ['lab_or_result_review', /\b(lab|labs|result|results|cbc|cmp|albumin|prealbumin|culture|sensitivity|a1c|hba1c|kidney|renal|creatinine)\b/i],
  ['wound_or_dressing_care', /\b(wound|ulcer|dressing|dressings|debridement|debride|compression|offload|offloading|graft|skin substitute|boot|stocking)\b/i],
  ['referral_or_care_coordination', /\b(referral|refer|vascular|podiatry|endocrinology|hospice|home health|care team|provider)\b/i],
  ['smoking_or_lifestyle', /\b(smoking|tobacco|diet|exercise|nutrition|counsel|counseled|education)\b/i],
  ['appointment_or_admin', /\b(appointment|schedule|scheduled|pharmacy|pick up|paperwork|form)\b/i],
  ['encoded_attachment', /^[A-Za-z0-9+/=\s]{200,}$/]
];

function parseArgs(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const options = {
    input: null,
    jsonOut: path.join(DEFAULT_OUT_ROOT, `narrative-signal-analysis-${stamp}.json`),
    mdOut: path.join(DEFAULT_OUT_ROOT, `narrative-signal-analysis-${stamp}.md`),
    maxExamples: DEFAULT_MAX_EXAMPLES,
    maxChars: DEFAULT_MAX_CHARS
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      options.jsonOut = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      options.mdOut = path.resolve(argv[++i]);
    } else if (arg === '--max-examples') {
      options.maxExamples = positiveInt(argv[++i], '--max-examples');
    } else if (arg === '--max-chars') {
      options.maxChars = positiveInt(argv[++i], '--max-chars');
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

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function printUsage() {
  console.log(`Usage: npm run bulk:narrative-signals -- [input-dir] [options]

Options:
  --out <path>            JSON output path
  --markdown <path>       Markdown output path
  --max-examples <n>      Redacted examples per theme/path
  --max-chars <n>         Max characters per redacted example

Output is local-only and may still contain clinical detail after redaction.`);
}

async function newestChildDirectory(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);
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

function typeFromFilename(filePath) {
  return path.basename(filePath, '.ndjson').replace(/^\d+_/, '');
}

function normalizedPath(fieldPath) {
  return fieldPath.replace(/\[\]/g, '[]');
}

function isNarrativePath(resourceType, fieldPath) {
  return NARRATIVE_PATHS.has(`${resourceType}.${normalizedPath(fieldPath)}`);
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

function redact(value) {
  return stripHtml(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]')
    .replace(/\b\d{1,5}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Court|Ct)\b/gi, '[ADDRESS]')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?\b/g, '[DATE]')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '[DATE]')
    .replace(/\b(MRN|Medical Record|Account|Acct|SSN)\s*[:#]?\s*[A-Za-z0-9-]+\b/gi, '$1 [ID]')
    .replace(/\b(MALE NAME|FEMALE NAME)\b/gi, '[NAME]')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function classify(text) {
  const themes = [];
  for (const [theme, regex] of THEME_RULES) {
    if (regex.test(text)) themes.push(theme);
  }
  return themes.length ? themes : ['uncategorized'];
}

function addExample(entry, text, options) {
  const sample = truncate(text, options.maxChars);
  if (!sample || entry.examples.includes(sample) || entry.examples.length >= options.maxExamples) return;
  entry.examples.push(sample);
}

function ensureField(state, key, resourceType, fieldPath) {
  if (!state.fields.has(key)) {
    state.fields.set(key, {
      resourceType,
      fieldPath,
      count: 0,
      unique: new Set(),
      totalChars: 0,
      themeCounts: new Map(),
      examples: []
    });
  }
  return state.fields.get(key);
}

function ensureTheme(state, theme) {
  if (!state.themes.has(theme)) {
    state.themes.set(theme, {
      theme,
      count: 0,
      fieldCounts: new Map(),
      examples: []
    });
  }
  return state.themes.get(theme);
}

function recordNarrative(state, resourceType, fieldPath, value, options) {
  if (typeof value !== 'string' || !isNarrativePath(resourceType, fieldPath)) return;

  const redacted = redact(value);
  if (!redacted) return;

  const key = `${resourceType}.${normalizedPath(fieldPath)}`;
  const themes = classify(redacted);
  const field = ensureField(state, key, resourceType, normalizedPath(fieldPath));
  field.count++;
  field.unique.add(redacted);
  field.totalChars += redacted.length;
  addExample(field, redacted, options);

  for (const theme of themes) {
    field.themeCounts.set(theme, (field.themeCounts.get(theme) || 0) + 1);
    const themeEntry = ensureTheme(state, theme);
    themeEntry.count++;
    themeEntry.fieldCounts.set(key, (themeEntry.fieldCounts.get(key) || 0) + 1);
    addExample(themeEntry, redacted, options);
  }
}

function walk(value, resourceType, fieldPath, state, options) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, resourceType, `${fieldPath}[]`, state, options);
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, resourceType, fieldPath ? `${fieldPath}.${key}` : key, state, options);
    }
    return;
  }

  recordNarrative(state, resourceType, fieldPath, value, options);
}

async function scanFile(filePath, state, options) {
  const fallbackType = typeFromFilename(filePath);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let records = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records++;
    const resource = JSON.parse(trimmed);
    walk(resource, resource.resourceType || fallbackType, '', state, options);
  }

  return records;
}

function serializeMap(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function buildPayload(state, inputDir, files, recordsByFile) {
  const fields = [...state.fields.values()]
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType) || a.fieldPath.localeCompare(b.fieldPath))
    .map(field => ({
      resourceType: field.resourceType,
      fieldPath: field.fieldPath,
      count: field.count,
      uniqueCount: field.unique.size,
      averageChars: Math.round(field.totalChars / Math.max(1, field.count)),
      themeCounts: serializeMap(field.themeCounts),
      redactedExamples: field.examples
    }));

  const themes = [...state.themes.values()]
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme))
    .map(theme => ({
      theme: theme.theme,
      count: theme.count,
      fieldCounts: serializeMap(theme.fieldCounts),
      redactedExamples: theme.examples
    }));

  return {
    generatedAt: new Date().toISOString(),
    inputDirectory: inputDir,
    privacyMode: 'unlinked-redacted-field-level',
    warning: 'Review artifacts may still contain clinical detail after redaction. Do not share without approval.',
    narrativePathsAnalyzed: [...NARRATIVE_PATHS].sort(),
    files: files.map(file => ({ name: path.basename(file), records: recordsByFile.get(file) || 0 })),
    totals: {
      narrativeFieldPaths: fields.length,
      narrativeTexts: fields.reduce((sum, field) => sum + field.count, 0),
      themes: themes.length
    },
    fields,
    themes
  };
}

function buildMarkdown(payload) {
  const lines = [];
  lines.push('# Narrative Signal Analysis');
  lines.push('');
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push(`Privacy mode: ${payload.privacyMode}`);
  lines.push('');
  lines.push('This artifact is unlinked and redacted, but it may still contain clinical detail. Keep it local.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Narrative field paths analyzed: ${payload.totals.narrativeFieldPaths}`);
  lines.push(`- Narrative text values analyzed: ${payload.totals.narrativeTexts}`);
  lines.push(`- Themes detected: ${payload.totals.themes}`);
  lines.push('');
  lines.push('## Theme Counts');
  lines.push('');
  for (const theme of payload.themes) {
    lines.push(`- ${theme.theme}: ${theme.count}`);
  }
  lines.push('');
  lines.push('## Field Counts');
  lines.push('');
  for (const field of payload.fields) {
    lines.push(`- ${field.resourceType}.${field.fieldPath}: ${field.count} values, ${field.uniqueCount} unique, avg ${field.averageChars} chars`);
  }
  lines.push('');
  lines.push('## AI Opportunity Readout');
  lines.push('');
  lines.push('- CarePlan narrative can likely produce aggregate care-plan themes such as diabetes medication management, follow-up timing, referrals, lifestyle counseling, and wound-care instructions.');
  lines.push('- MedicationRequest dosage text can likely produce aggregate medication-instruction complexity and medication class themes.');
  lines.push('- DiagnosticReport presented forms should remain a separate decode/review lane because they appear attachment-like and may contain richer clinical reports.');
  lines.push('- Patient narrative should not be surfaced directly; use only as a redaction/test source unless a safer use case is defined.');
  lines.push('');
  lines.push('## Redacted Examples By Theme');
  lines.push('');
  for (const theme of payload.themes) {
    lines.push(`### ${theme.theme}`);
    lines.push('');
    lines.push(`Count: ${theme.count}`);
    lines.push('');
    for (const example of theme.redactedExamples) {
      lines.push(`- ${example}`);
    }
    lines.push('');
  }
  lines.push('## Redacted Examples By Field');
  lines.push('');
  for (const field of payload.fields) {
    lines.push(`### ${field.resourceType}.${field.fieldPath}`);
    lines.push('');
    lines.push(`Count: ${field.count}`);
    lines.push('');
    lines.push('Themes:');
    for (const [theme, count] of Object.entries(field.themeCounts)) {
      lines.push(`- ${theme}: ${count}`);
    }
    lines.push('');
    for (const example of field.redactedExamples) {
      lines.push(`- ${example}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputDir = await resolveInput(options.input);
  const files = await findNdjsonFiles(inputDir);
  if (!files.length) throw new Error(`No .ndjson files found in ${inputDir}`);

  const state = {
    fields: new Map(),
    themes: new Map()
  };
  const recordsByFile = new Map();

  for (const file of files) {
    recordsByFile.set(file, await scanFile(file, state, options));
  }

  const payload = buildPayload(state, inputDir, files, recordsByFile);
  await fsp.mkdir(path.dirname(options.jsonOut), { recursive: true, mode: 0o700 });
  await fsp.writeFile(options.jsonOut, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fsp.chmod(options.jsonOut, 0o600);
  await fsp.writeFile(options.mdOut, buildMarkdown(payload), { mode: 0o600 });
  await fsp.chmod(options.mdOut, 0o600);

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: inputDir,
    jsonPath: options.jsonOut,
    markdownPath: options.mdOut,
    privacyMode: payload.privacyMode,
    narrativeTexts: payload.totals.narrativeTexts,
    narrativeFieldPaths: payload.totals.narrativeFieldPaths,
    themes: payload.themes.map(theme => ({ theme: theme.theme, count: theme.count })),
    warning: payload.warning
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
