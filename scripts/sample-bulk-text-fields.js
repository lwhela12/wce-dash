#!/usr/bin/env node
/**
 * Create a local-only text-field sample document from FHIR Bulk NDJSON files.
 *
 * This intentionally samples raw text-like FHIR values so a human can assess
 * PHI risk and utility. Do not paste the output into chats, tickets, logs, or
 * shared documents unless it has been reviewed and approved.
 *
 * Console output contains only metadata and the output path, never samples.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const DEFAULT_INPUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads');
const DEFAULT_OUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads');
const DEFAULT_MAX_EXAMPLES = 5;
const DEFAULT_MAX_CHARS = 700;

function parseArgs(argv) {
  const options = {
    input: null,
    out: null,
    maxExamples: DEFAULT_MAX_EXAMPLES,
    maxChars: DEFAULT_MAX_CHARS,
    includeDisplay: true
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      options.out = path.resolve(argv[++i]);
    } else if (arg === '--max-examples') {
      options.maxExamples = positiveInt(argv[++i], '--max-examples');
    } else if (arg === '--max-chars') {
      options.maxChars = positiveInt(argv[++i], '--max-chars');
    } else if (arg === '--no-display') {
      options.includeDisplay = false;
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
  if (!options.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    options.out = path.join(DEFAULT_OUT_ROOT, `text-field-samples-${stamp}.txt`);
  }
  return options;
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function printUsage() {
  console.log(`Usage: npm run bulk:text-samples -- [input-dir] [options]

Options:
  --out <path>            Output text file path
  --max-examples <n>      Examples per field path (default: ${DEFAULT_MAX_EXAMPLES})
  --max-chars <n>         Max characters per example (default: ${DEFAULT_MAX_CHARS})
  --no-display            Exclude *.display fields and focus on narrative-ish text

The generated file may contain PHI. It is written locally with mode 0600.`);
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
  const newest = await newestChildDirectory(input);
  return newest;
}

function typeFromFilename(filePath) {
  return path.basename(filePath, '.ndjson').replace(/^\d+_/, '');
}

function isTextLikePath(fieldPath, includeDisplay) {
  const normalized = fieldPath.replace(/\[\]/g, '');
  const segments = normalized.split('.');
  const last = segments[segments.length - 1];

  if (['text', 'div', 'description', 'title', 'comment', 'patientInstruction', 'data'].includes(last)) return true;
  if (includeDisplay && last === 'display') return true;
  if (last === 'valueString') return true;
  if (normalized.includes('.note.text')) return true;
  if (normalized.includes('.dosageInstruction.text')) return true;
  if (normalized.includes('.presentedForm.data')) return true;
  return false;
}

function cleanSample(value, maxChars) {
  const cleaned = String(value)
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}... [truncated ${cleaned.length - maxChars} chars]`;
}

function addSample(samplesByPath, resourceType, fieldPath, value, options) {
  if (typeof value !== 'string') return;
  if (!isTextLikePath(fieldPath, options.includeDisplay)) return;
  const cleaned = cleanSample(value, options.maxChars);
  if (!cleaned) return;

  const key = `${resourceType}\t${fieldPath}`;
  if (!samplesByPath.has(key)) {
    samplesByPath.set(key, {
      resourceType,
      fieldPath,
      occurrences: 0,
      samples: []
    });
  }

  const entry = samplesByPath.get(key);
  entry.occurrences++;
  if (entry.samples.length >= options.maxExamples) return;
  if (entry.samples.includes(cleaned)) return;
  entry.samples.push(cleaned);
}

function walk(value, resourceType, fieldPath, samplesByPath, options) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, resourceType, `${fieldPath}[]`, samplesByPath, options);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, resourceType, fieldPath ? `${fieldPath}.${key}` : key, samplesByPath, options);
    }
    return;
  }

  addSample(samplesByPath, resourceType, fieldPath, value, options);
}

async function scanFile(filePath, samplesByPath, options) {
  const fallbackType = typeFromFilename(filePath);
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let records = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records++;
    const resource = JSON.parse(trimmed);
    walk(resource, resource.resourceType || fallbackType, '', samplesByPath, options);
  }

  return records;
}

function buildReport({ inputDir, files, recordsByFile, samplesByPath, options }) {
  const lines = [];
  lines.push('FHIR Bulk Text Field Samples');
  lines.push('============================');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Input directory: ${inputDir}`);
  lines.push(`Files scanned: ${files.length}`);
  lines.push(`Max examples per field: ${options.maxExamples}`);
  lines.push(`Max characters per example: ${options.maxChars}`);
  lines.push(`Display fields included: ${options.includeDisplay ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('WARNING: This file may contain PHI or clinical narrative. Keep it local and review before sharing.');
  lines.push('');
  lines.push('Files');
  lines.push('-----');
  for (const file of files) {
    lines.push(`- ${path.basename(file)}: ${recordsByFile.get(file) || 0} records`);
  }
  lines.push('');

  const entries = [...samplesByPath.values()]
    .sort((a, b) => a.resourceType.localeCompare(b.resourceType) || a.fieldPath.localeCompare(b.fieldPath));

  lines.push(`Text-like field paths found: ${entries.length}`);
  lines.push('');

  for (const entry of entries) {
    lines.push(`${entry.resourceType}.${entry.fieldPath}`);
    lines.push('-'.repeat(Math.min(100, `${entry.resourceType}.${entry.fieldPath}`.length)));
    lines.push(`Occurrences: ${entry.occurrences}`);
    lines.push('');
    entry.samples.forEach((sample, index) => {
      lines.push(`Example ${index + 1}:`);
      lines.push(sample);
      lines.push('');
    });
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputDir = await resolveInput(options.input);
  const files = await findNdjsonFiles(inputDir);
  if (!files.length) throw new Error(`No .ndjson files found in ${inputDir}`);

  const samplesByPath = new Map();
  const recordsByFile = new Map();
  for (const file of files) {
    recordsByFile.set(file, await scanFile(file, samplesByPath, options));
  }

  await fsp.mkdir(path.dirname(options.out), { recursive: true, mode: 0o700 });
  const report = buildReport({ inputDir, files, recordsByFile, samplesByPath, options });
  await fsp.writeFile(options.out, report, { mode: 0o600 });
  await fsp.chmod(options.out, 0o600);

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: inputDir,
    outputPath: options.out,
    filesScanned: files.length,
    textFieldPaths: samplesByPath.size,
    maxExamplesPerField: options.maxExamples,
    phiWarning: 'Output file may contain PHI. Review locally and do not share without approval.'
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
