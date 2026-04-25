#!/usr/bin/env node
/**
 * PHI-minimized FHIR Bulk NDJSON structure profiler.
 *
 * This script streams local NDJSON files and emits only structural aggregates:
 * resource counts, field paths, detected value categories, fill rates, reference
 * target resource types, and coding system identifiers. It never prints raw
 * resource records, scalar field values, patient identifiers, names, or dates.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

const DEFAULT_INPUT_ROOT = path.join(process.cwd(), 'private-fhir-downloads');
const DEFAULT_JSON_OUT = path.join(process.cwd(), 'data', 'bulk-profile.json');
const DEFAULT_MD_OUT = path.join(process.cwd(), 'data', 'bulk-profile.md');

const MAX_SYSTEMS_PER_RESOURCE = 80;
const MAX_REFERENCE_PATHS_PER_RESOURCE = 120;
const MAX_PARSE_ERRORS = 20;

function parseArgs(argv) {
  const options = {
    input: null,
    jsonOut: DEFAULT_JSON_OUT,
    mdOut: DEFAULT_MD_OUT,
    maxRecordsPerFile: Infinity,
    noMarkdown: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      options.jsonOut = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      options.mdOut = path.resolve(argv[++i]);
    } else if (arg === '--no-markdown') {
      options.noMarkdown = true;
    } else if (arg === '--max-records-per-file') {
      const limit = Number(argv[++i]);
      if (!Number.isFinite(limit) || limit < 1) throw new Error('--max-records-per-file must be a positive number');
      options.maxRecordsPerFile = Math.floor(limit);
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
  console.log(`Usage: npm run bulk:profile -- [input-dir-or-file] [options]

Options:
  --out <path>                   JSON output path (default: data/bulk-profile.json)
  --markdown <path>              Markdown output path (default: data/bulk-profile.md)
  --no-markdown                  Skip Markdown output
  --max-records-per-file <n>     Sample only the first n records per NDJSON file

The generated profile is structural only. It does not contain raw FHIR values.`);
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (_) {
    return false;
  }
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

async function resolveInput(input) {
  const stat = await fsp.stat(input);
  if (stat.isFile()) return input;

  const directFiles = await findNdjsonFiles(input);
  if (directFiles.length > 0) return input;

  const newest = await newestChildDirectory(input);
  if (newest !== input && (await findNdjsonFiles(newest)).length > 0) {
    return newest;
  }

  return input;
}

async function findNdjsonFiles(input) {
  const stat = await fsp.stat(input);
  if (stat.isFile()) {
    return input.endsWith('.ndjson') ? [input] : [];
  }

  const entries = await fsp.readdir(input, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.ndjson'))
    .map(entry => path.join(input, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function makeResourceProfile(resourceType) {
  return {
    resourceType,
    recordCount: 0,
    sampledRecordCount: 0,
    files: new Set(),
    paths: new Map(),
    referenceTargets: new Map(),
    codingSystems: new Set()
  };
}

function makePathProfile() {
  return {
    presentInRecords: 0,
    occurrences: 0,
    categories: new Set(),
    arrayElementCategories: new Set()
  };
}

function getPathProfile(resourceProfile, fieldPath) {
  if (!resourceProfile.paths.has(fieldPath)) {
    resourceProfile.paths.set(fieldPath, makePathProfile());
  }
  return resourceProfile.paths.get(fieldPath);
}

function addReference(resourceProfile, fieldPath, referenceValue) {
  if (typeof referenceValue !== 'string') return;
  const match = referenceValue.match(/^([A-Z][A-Za-z]+)\//);
  if (!match) return;

  const target = match[1];
  const key = `${fieldPath} -> ${target}`;
  resourceProfile.referenceTargets.set(key, {
    path: fieldPath,
    targetResourceType: target,
    count: (resourceProfile.referenceTargets.get(key)?.count || 0) + 1
  });
}

function addCodingSystem(resourceProfile, fieldPath, value) {
  if (typeof value !== 'string') return;
  const lowerPath = fieldPath.toLowerCase();
  if (!lowerPath.endsWith('.system') && lowerPath !== 'system') return;
  resourceProfile.codingSystems.add(value);
}

function categorizeScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
  if (typeof value !== 'string') return typeof value;

  if (/^[A-Z][A-Za-z]+\/[^/\s]+$/.test(value)) return 'reference';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'dateTime';
  if (/^https?:\/\//i.test(value) || /^urn:/i.test(value)) return 'uri';
  if (/^[A-Z]\d{2}(\.\d+)?$/i.test(value)) return 'codeLikeString';
  return 'string';
}

function recordPath(resourceProfile, fieldPath, category, seenPaths, isArrayElement = false) {
  const profile = getPathProfile(resourceProfile, fieldPath);
  profile.occurrences += 1;
  profile.categories.add(category);
  if (isArrayElement) profile.arrayElementCategories.add(category);
  seenPaths.add(fieldPath);
}

function walkValue(resourceProfile, value, fieldPath, seenPaths, isArrayElement = false) {
  if (Array.isArray(value)) {
    recordPath(resourceProfile, fieldPath, 'array', seenPaths, isArrayElement);
    for (const item of value) {
      walkValue(resourceProfile, item, `${fieldPath}[]`, seenPaths, true);
    }
    return;
  }

  if (value && typeof value === 'object') {
    recordPath(resourceProfile, fieldPath, 'object', seenPaths, isArrayElement);
    for (const [key, child] of Object.entries(value)) {
      walkValue(resourceProfile, child, fieldPath ? `${fieldPath}.${key}` : key, seenPaths);
    }
    return;
  }

  const category = categorizeScalar(value);
  recordPath(resourceProfile, fieldPath, category, seenPaths, isArrayElement);
  if (category === 'reference') addReference(resourceProfile, fieldPath, value);
  addCodingSystem(resourceProfile, fieldPath, value);
}

function inferResourceTypeFromFilename(filePath) {
  const base = path.basename(filePath, '.ndjson');
  return base.replace(/^\d+_/, '') || 'Unknown';
}

async function profileFile(filePath, state, maxRecordsPerFile) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let sampled = 0;

  for await (const line of rl) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (sampled >= maxRecordsPerFile) continue;

    let resource;
    try {
      resource = JSON.parse(trimmed);
    } catch (error) {
      if (state.parseErrors.length < MAX_PARSE_ERRORS) {
        state.parseErrors.push({ file: path.basename(filePath), line: lineNumber, error: error.message });
      }
      continue;
    }

    sampled += 1;
    const resourceType = resource.resourceType || inferResourceTypeFromFilename(filePath);
    if (!state.resources.has(resourceType)) {
      state.resources.set(resourceType, makeResourceProfile(resourceType));
    }

    const resourceProfile = state.resources.get(resourceType);
    resourceProfile.recordCount += 1;
    resourceProfile.sampledRecordCount += 1;
    resourceProfile.files.add(path.basename(filePath));

    const seenPaths = new Set();
    walkValue(resourceProfile, resource, '', seenPaths);
    for (const seenPath of seenPaths) {
      getPathProfile(resourceProfile, seenPath).presentInRecords += 1;
    }
  }
}

function roundPercent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function serializeResource(profile) {
  const paths = [...profile.paths.entries()]
    .filter(([fieldPath]) => fieldPath)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fieldPath, stats]) => ({
      path: fieldPath,
      presentInRecords: stats.presentInRecords,
      fillRatePct: roundPercent(stats.presentInRecords, profile.recordCount),
      occurrences: stats.occurrences,
      categories: [...stats.categories].sort(),
      arrayElementCategories: [...stats.arrayElementCategories].sort(),
      placeholder: placeholderForCategories(stats.categories)
    }));

  const referenceTargets = [...profile.referenceTargets.values()]
    .sort((a, b) => a.path.localeCompare(b.path) || a.targetResourceType.localeCompare(b.targetResourceType))
    .slice(0, MAX_REFERENCE_PATHS_PER_RESOURCE);

  return {
    recordCount: profile.recordCount,
    sampledRecordCount: profile.sampledRecordCount,
    files: [...profile.files].sort(),
    codingSystems: [...profile.codingSystems].sort().slice(0, MAX_SYSTEMS_PER_RESOURCE),
    referenceTargets,
    paths
  };
}

function placeholderForCategories(categories) {
  const ordered = [...categories].sort();
  if (ordered.includes('array')) return '<array>';
  if (ordered.includes('object')) return '<object>';
  if (ordered.includes('reference')) return '<Resource/id>';
  if (ordered.includes('dateTime')) return '<dateTime>';
  if (ordered.includes('date')) return '<date>';
  if (ordered.includes('uri')) return '<uri>';
  if (ordered.includes('integer')) return '<integer>';
  if (ordered.includes('decimal')) return '<decimal>';
  if (ordered.includes('boolean')) return '<boolean>';
  if (ordered.includes('codeLikeString')) return '<code>';
  if (ordered.includes('null')) return '<null>';
  return '<string>';
}

function buildMarkdown(profile) {
  const lines = [];
  lines.push('# FHIR Bulk Structure Profile');
  lines.push('');
  lines.push(`Generated: ${profile.generatedAt}`);
  lines.push(`Input: \`${profile.inputDirectory}\``);
  lines.push(`Files: ${profile.files.length}`);
  lines.push(`Records profiled: ${profile.totalRecords}`);
  lines.push('');
  lines.push('This profile is structural only. It excludes raw scalar values, patient identifiers, names, addresses, exact dates, and free-text content.');
  lines.push('');
  lines.push('## Resources');
  lines.push('');
  lines.push('| Resource | Records | Files | Paths | Coding systems | References |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const [resourceType, resource] of Object.entries(profile.resources)) {
    lines.push(`| ${resourceType} | ${resource.recordCount} | ${resource.files.length} | ${resource.paths.length} | ${resource.codingSystems.length} | ${resource.referenceTargets.length} |`);
  }

  for (const [resourceType, resource] of Object.entries(profile.resources)) {
    lines.push('');
    lines.push(`## ${resourceType}`);
    lines.push('');
    lines.push(`Records: ${resource.recordCount}`);
    if (resource.codingSystems.length) {
      lines.push('');
      lines.push('Coding systems:');
      for (const system of resource.codingSystems.slice(0, 20)) {
        lines.push(`- \`${system}\``);
      }
    }
    if (resource.referenceTargets.length) {
      lines.push('');
      lines.push('Reference targets:');
      for (const ref of resource.referenceTargets.slice(0, 20)) {
        lines.push(`- \`${ref.path}\` -> \`${ref.targetResourceType}\` (${ref.count})`);
      }
    }
    lines.push('');
    lines.push('Top populated paths:');
    const topPaths = [...resource.paths]
      .sort((a, b) => b.fillRatePct - a.fillRatePct || a.path.localeCompare(b.path))
      .slice(0, 40);
    for (const field of topPaths) {
      lines.push(`- \`${field.path}\`: ${field.categories.join('|')} (${field.fillRatePct}% records)`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!(await pathExists(options.input))) {
    throw new Error(`Input path does not exist: ${options.input}`);
  }

  const input = await resolveInput(options.input);
  const files = await findNdjsonFiles(input);
  if (files.length === 0) {
    throw new Error(`No .ndjson files found in: ${input}`);
  }

  const state = {
    resources: new Map(),
    parseErrors: []
  };

  for (const file of files) {
    await profileFile(file, state, options.maxRecordsPerFile);
  }

  const resources = {};
  for (const [resourceType, resourceProfile] of [...state.resources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    resources[resourceType] = serializeResource(resourceProfile);
  }

  const profile = {
    generatedAt: new Date().toISOString(),
    inputDirectory: input,
    files: files.map(file => path.basename(file)),
    totalRecords: Object.values(resources).reduce((sum, resource) => sum + resource.recordCount, 0),
    privacy: {
      mode: 'structure-only',
      rawValuesIncluded: false,
      omitted: ['names', 'patient identifiers', 'addresses', 'telecom values', 'raw dates', 'free text', 'resource IDs', 'reference IDs']
    },
    parseErrors: state.parseErrors,
    resources
  };

  await fsp.mkdir(path.dirname(options.jsonOut), { recursive: true });
  await fsp.writeFile(options.jsonOut, JSON.stringify(profile, null, 2), { mode: 0o600 });

  let markdownPath = null;
  if (!options.noMarkdown) {
    markdownPath = options.mdOut;
    await fsp.mkdir(path.dirname(markdownPath), { recursive: true });
    await fsp.writeFile(markdownPath, buildMarkdown(profile), { mode: 0o600 });
  }

  console.log(JSON.stringify({
    ok: true,
    inputDirectory: input,
    jsonPath: options.jsonOut,
    markdownPath,
    files: files.length,
    totalRecords: profile.totalRecords,
    resourceTypes: Object.keys(resources)
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
