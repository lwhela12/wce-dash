require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { FHIRClient } = require('./fhir-client');
const { transformToDatabase } = require('./transform');
const { deidentify } = require('./deidentify');
const { generateSyntheticData } = require('./synthetic-data');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Resolve FHIR base URL from mode
const FHIR_MODE = process.env.FHIR_MODE || 'test';
// Use org-specific URL for direct calls, but aud uses the base without org
const FHIR_BASE_URL_WITH_ORG = FHIR_MODE === 'production'
  ? process.env.FHIR_PROD_BASE_URL
  : process.env.FHIR_TEST_BASE_URL;
// Token-based queries use the base without org — AdvancedMD routes by token
const FHIR_BASE_URL = 'https://providerapi.advancedmd.com/v1/r4';

// ========================================
// PHI POLICY: NO PERSISTENT STORAGE
// ========================================
// Raw FHIR data (PHI) is held in memory ONLY during
// the transform step, then discarded. Only de-identified
// aggregate metrics are cached to disk.
//
// The metrics cache contains counts, rates, and provider
// initials — no patient names, DOBs, MRNs, or any of
// the 18 HIPAA identifiers.
// ========================================

// In-memory PKCE verifier (per OAuth session)
let pkceVerifier = null;

// In-memory token store (never written to disk)
let tokenStore = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  scope: null
};

// In-memory metrics cache (de-identified only)
let metricsCache = {
  data: null,
  timestamp: null
};

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const LOCAL_BULK_METRICS_PATH = path.join(__dirname, 'data', 'bulk-dashboard-metrics.json');

const fhirClient = new FHIRClient({
  baseUrl: FHIR_BASE_URL,
  tokenUrl: process.env.FHIR_TOKEN_URL
});

function readLocalBulkDashboardMetrics() {
  if (!fs.existsSync(LOCAL_BULK_METRICS_PATH)) return null;
  const payload = JSON.parse(fs.readFileSync(LOCAL_BULK_METRICS_PATH, 'utf8'));
  if (!payload?.data) return null;
  return payload;
}

// ========================================
// JWKS endpoint — serves public key with correct Content-Type
// ========================================
app.get('/.well-known/jwks.json', (req, res) => {
  const jwks = JSON.parse(fs.readFileSync(path.join(__dirname, 'jwks.json'), 'utf8'));
  res.setHeader('Content-Type', 'application/json');
  res.json(jwks);
});

app.use(express.json());

// ========================================
// PUBLIC ASSETS
// ========================================
// Never serve the repository root. Raw FHIR downloads, generated metrics,
// scripts, keys, docs, and local config live under the project directory and
// must not become browseable web assets.
if (fs.existsSync(PUBLIC_DIR)) {
  app.use('/assets', express.static(PUBLIC_DIR, {
    index: false,
    fallthrough: false
  }));
}

app.get('/WCE_Specialty_Logo_update_healing.jpeg.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'WCE_Specialty_Logo_update_healing.jpeg.jpg'));
});

// ========================================
// DEBUG: Test a single FHIR resource
// ========================================
app.get('/api/test-fhir/:resourceType', async (req, res) => {
  if (!tokenStore.accessToken) return res.status(401).json({ error: 'Not connected' });
  try {
    // Try multiple base URL formats to find what works
    const bases = [
      FHIR_BASE_URL,                                          // v1/r4/174
      'https://providerapi.advancedmd.com/v1/r4',             // no org
      `https://providerapi.advancedmd.com/v1/r4/${tokenStore.officeKey || '991900'}`, // office key as org
    ];

    const results = [];
    for (const base of bases) {
      const url = `${base}/${req.params.resourceType}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${tokenStore.accessToken}`,
          'Accept': 'application/fhir+json'
        }
      });
      const data = await response.json();
      results.push({ base, status: response.status, hasEntries: !!(data.entry), total: data.total, error: data.issue?.[0]?.diagnostics });
      if (response.ok && data.entry) {
        return res.json({ workingBase: base, status: response.status, data });
      }
    }
    res.json({ message: 'None of the base URLs worked', results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// MAIN DASHBOARD ROUTE
// ========================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'fhir-dashboard.html'));
});

app.get('/original', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========================================
// AUTH: KICK OFF SMART LAUNCH
// ========================================

app.get('/auth/launch', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, maxAge: 600000 });

  // PKCE: generate code_verifier and code_challenge (S256)
  pkceVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(pkceVerifier)
    .digest('base64url');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.FHIR_CLIENT_ID_BULK,
    redirect_uri: process.env.REDIRECT_URI,
    scope: 'openid fhirUser offline_access online_access',
    state: state,
    aud: 'https://providerapi.advancedmd.com/v1/r4',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  const authUrl = `${process.env.FHIR_AUTH_URL}?${params.toString()}`;
  console.log('\n--- SMART Launch (PKCE) ---');
  console.log('Redirecting to:', authUrl);
  res.redirect(authUrl);
});

// ========================================
// AUTH: CALLBACK — EXCHANGE CODE FOR TOKEN
// ========================================

app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error('OAuth error:', error, error_description);
    return res.redirect('/?auth=error&message=' + encodeURIComponent(error_description || error));
  }

  if (!code) {
    return res.redirect('/?auth=error&message=No+authorization+code+received');
  }

  try {
    console.log('\n--- Token Exchange ---');
    console.log('Authorization code received, exchanging for token...');

    const basicAuth = Buffer.from(
      `${process.env.FHIR_CLIENT_ID_BULK}:${process.env.FHIR_CLIENT_SECRET_BULK}`
    ).toString('base64');

    const tokenResponse = await fetch(process.env.FHIR_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.REDIRECT_URI,
        code_verifier: pkceVerifier
      })
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      console.error('Token exchange failed:', tokenResponse.status, errorBody);
      return res.redirect('/?auth=error&message=' + encodeURIComponent('Token exchange failed: ' + tokenResponse.status));
    }

    const tokenData = await tokenResponse.json();
    console.log('Token received! Scopes:', tokenData.scope);
    console.log('Expires in:', tokenData.expires_in, 'seconds');

    // Token is held in memory only — never written to disk
    console.log('Full token response keys:', Object.keys(tokenData));
    console.log('Token response (no secrets):', JSON.stringify({
      ...tokenData,
      access_token: tokenData.access_token?.substring(0, 10) + '...',
      refresh_token: tokenData.refresh_token ? '(present)' : '(none)',
      id_token: tokenData.id_token ? '(present)' : '(none)'
    }, null, 2));

    tokenStore = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
      scope: tokenData.scope,
      patient: tokenData.patient || null,
      officeKey: tokenData.code || tokenData.officekey || tokenData.office_key || null,
      fhirUser: tokenData.fhirUser || null,
      aud: tokenData.aud || null,
      raw: tokenData // keep full response for debugging
    };

    // Clear stale cache so dashboard fetches fresh live data
    metricsCache = { data: null, timestamp: null };

    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Token exchange error:', err);
    res.redirect('/?auth=error&message=' + encodeURIComponent(err.message));
  }
});

// ========================================
// AUTH STATUS
// ========================================

app.get('/api/auth/status', (req, res) => {
  const connected = !!(tokenStore.accessToken && tokenStore.expiresAt > Date.now());
  const hasCachedMetrics = !!(metricsCache.data && metricsCache.timestamp);
  res.json({
    connected,
    mode: FHIR_MODE,
    fhirBaseUrl: FHIR_BASE_URL,
    expiresAt: tokenStore.expiresAt,
    scope: tokenStore.scope,
    dataSource: connected ? 'live' : hasCachedMetrics ? 'cached-metrics' : 'synthetic',
    metricsCachedAt: metricsCache.timestamp
  });
});

app.post('/api/auth/disconnect', (req, res) => {
  tokenStore = { accessToken: null, refreshToken: null, expiresAt: null, scope: null };
  // Note: metrics cache is de-identified, safe to keep
  res.json({ disconnected: true });
});

// ========================================
// DASHBOARD DATA — STREAM & AGGREGATE
// ========================================
// PHI flow:
//   1. FHIR resources fetched into memory
//   2. transform() aggregates into counts/rates
//   3. deidentify() strips any remaining PHI
//   4. Raw FHIR data goes out of scope → garbage collected
//   5. Only de-identified metrics are cached/returned
// ========================================

app.get('/api/dashboard-data', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  const localBulkMetrics = readLocalBulkDashboardMetrics();
  if (localBulkMetrics) {
    metricsCache = {
      data: localBulkMetrics.data,
      timestamp: Date.now()
    };
    return res.json({
      dataSource: localBulkMetrics.dataSource || 'local-bulk-dashboard',
      data: localBulkMetrics.data,
      generatedAt: localBulkMetrics.generatedAt,
      phiStatus: localBulkMetrics.phiStatus
    });
  }

  // Return cached de-identified metrics if fresh
  if (!forceRefresh && metricsCache.data && metricsCache.timestamp) {
    const age = Date.now() - metricsCache.timestamp;
    if (age < CACHE_TTL_MS) {
      console.log(`Serving cached metrics (${Math.round(age / 1000)}s old)`);
      return res.json({
        dataSource: 'cached-metrics',
        data: metricsCache.data,
        cachedAt: new Date(metricsCache.timestamp).toISOString()
      });
    }
  }

  const hasBulkCreds = !!(process.env.FHIR_CLIENT_ID_BULK && process.env.FHIR_PROVIDER_USERNAME &&
    process.env.FHIR_CLIENT_ID_BULK !== 'your-bulk-client-key-here');

  try {
    const startTime = Date.now();
    let rawData;
    let source;

    if (hasBulkCreds && process.env.FHIR_TOKEN_URL) {
      try {
        // Use the full bulk export pipeline
        console.log('\n--- Bulk Export Pipeline ---');
        const accessToken = await getBulkToken();
        const groupId = process.env.FHIR_GROUP_ID;
        const exportResult = await startBulkExport(accessToken);

        let exportManifest;
        if (exportResult.mode === 'async') {
          if (!exportResult.jobId) throw new Error('No job ID from async export');
          exportManifest = await pollExportStatus(accessToken, groupId, exportResult.jobId, exportResult.contentLocation);
        } else {
          exportManifest = exportResult;
        }

        const resourceTypes = [
          'Patient', 'Condition', 'Procedure', 'Encounter',
          'Observation', 'ServiceRequest', 'MedicationRequest',
          'Practitioner', 'Location', 'Coverage', 'DiagnosticReport'
        ];
        rawData = await downloadBulkData(accessToken, exportManifest, resourceTypes);
        source = 'bulk-export';
      } catch (bulkErr) {
        console.log('Bulk export failed:', bulkErr.message);
        console.log('Falling back to synthetic data.');
        rawData = generateSyntheticData();
        source = 'synthetic';
      }
    } else {
      console.log('\n--- Generating Synthetic FHIR Data ---');
      rawData = generateSyntheticData();
      source = 'synthetic';
    }

    const fetchElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Data ready in ${fetchElapsed}s (source: ${source})`);

    // Transform into aggregate metrics
    const metrics = transformToDatabase(rawData);

    // De-identify — strip any remaining PHI (matters for live data)
    const safeMetrics = deidentify(metrics);

    // rawData goes out of scope → GC'd. No PHI persisted.
    metricsCache = {
      data: safeMetrics,
      timestamp: Date.now()
    };

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Dashboard metrics ready in ${totalElapsed}s (${source}, de-identified)`);

    res.json({
      dataSource: source,
      data: safeMetrics,
      fetchedIn: totalElapsed + 's'
    });
  } catch (err) {
    console.error('Dashboard data fetch error:', err);
    res.status(500).json({ error: err.message, dataSource: 'error' });
  }
});

async function fetchAllFHIRData(accessToken) {
  // Fetch one resource type at a time — sequential to avoid 429
  const types = [
    'Patient', 'Practitioner', 'Location', 'Coverage',
    'Condition', 'Encounter', 'Procedure', 'Observation',
    'ServiceRequest', 'MedicationRequest', 'DiagnosticReport'
  ];

  const data = {};
  for (const type of types) {
    const resources = await fhirClient.searchAll(type, {}, accessToken);
    const key = type.charAt(0).toLowerCase() + type.slice(1) + 's';
    data[key] = resources;
    // Small pause between resource types
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return data;
}

// ========================================
// BULK EXPORT — STREAM & AGGREGATE
// ========================================
// For larger data pulls using the Bulk API.
// Same PHI policy: stream NDJSON → aggregate → discard raw.
// ========================================

// ========================================
// BULK API — Full automated flow
// Step 1: Get JWT from JWKS API
// Step 2: Exchange JWT + credentials for access token
// Step 3: Kick off $export
// Step 4: Poll until complete
// Step 5: Download each resource type
// Step 6: Transform → deidentify → cache
// ========================================

let bulkTokenStore = { accessToken: null, expiresAt: null };

function getBulkOutputUrlsByType(exportResult) {
  const outputByType = {};

  for (const item of exportResult?.output || []) {
    if (!item?.type || !item?.url) continue;
    if (!outputByType[item.type]) outputByType[item.type] = [];
    outputByType[item.type].push(item.url);
  }

  return outputByType;
}

function parseBulkPayload(bodyText, contentType, expectedType) {
  const text = bodyText.trim();
  if (!text) return [];

  if ((contentType || '').toLowerCase().includes('ndjson')) {
    return text
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  }

  const parsed = JSON.parse(text);

  if (parsed.resourceType === 'Bundle' && Array.isArray(parsed.entry)) {
    return parsed.entry.map(entry => entry.resource).filter(Boolean);
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed.resourceType === expectedType) {
    return [parsed];
  }

  return [];
}

// Step 1: Create self-signed JWT (SMART Backend Services / private_key_jwt)
function createSelfSignedJWT(tokenUrl) {
  const privateKey = fs.readFileSync(path.join(__dirname, 'private_key.pem'), 'utf8');
  const clientId = process.env.FHIR_CLIENT_ID_BULK;

  // aud must match the token endpoint we're actually hitting
  const audience = tokenUrl || process.env.FHIR_JWKS_TOKEN_URL || process.env.FHIR_TOKEN_URL;

  return jwt.sign({
    iss: clientId,
    sub: clientId,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID()
  }, privateKey, {
    algorithm: 'RS384',   // Must match jwks.json "alg": "RS384"
    header: {
      kid: 'wce-dashboard-bulk-1',
      typ: 'JWT',
      jku: process.env.FHIR_JWKS_PUBLIC_URL   // Tells server where to fetch public key
    }
  });
}

// Step 2: Exchange JWT + provider credentials for access token
async function getBulkToken() {
  if (bulkTokenStore.accessToken && bulkTokenStore.expiresAt > Date.now()) {
    return bulkTokenStore.accessToken;
  }

  console.log('\n--- Bulk API: Authenticating (private_key_jwt) ---');

  // SMART Backend Services: POST to /v1/oauth2/token with client_assertion
  // Requires JWKS URL to be registered with AdvancedMD for this client_id.
  // Contact AdvancedMD InterOps: https://www.advancedmd.com/support/interoperability/
  const stdTokenUrl = process.env.FHIR_TOKEN_URL;
  const jwtForStdEndpoint = createSelfSignedJWT(stdTokenUrl);

  console.log(`  Token endpoint: ${stdTokenUrl}`);
  console.log(`  JWKS URL: ${process.env.FHIR_JWKS_PUBLIC_URL}`);
  console.log('  Self-signed JWT created (RS384, kid=wce-dashboard-bulk-1).');

  // AdvancedMD hybrid auth: JWT client_assertion + provider credentials
  // (username/password/officekey) — NOT pure SMART Backend Services
  const response = await fetch(stdTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'system/*.read',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwtForStdEndpoint,
      username: process.env.FHIR_PROVIDER_USERNAME || '',
      password: process.env.FHIR_PROVIDER_PASSWORD || '',
      officekey: process.env.FHIR_PROVIDER_OFFICEKEY || ''
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`  ✗ Token request failed (${response.status}): ${err.substring(0, 300)}`);

    if (err.includes('Public key url is invalid')) {
      throw new Error(
        'JWKS URL not registered with AdvancedMD. ' +
        'Contact InterOps support to associate your JWKS URL ' +
        `(${process.env.FHIR_JWKS_PUBLIC_URL}) with client ID ${process.env.FHIR_CLIENT_ID_BULK}. ` +
        'See: https://www.advancedmd.com/support/interoperability/'
      );
    }

    throw new Error(`Token exchange failed (${response.status}): ${err.substring(0, 300)}`);
  }

  const tokenData = await response.json();
  console.log('  ✓ Access token received! Expires in:', tokenData.expires_in, 'seconds');

  bulkTokenStore = {
    accessToken: tokenData.access_token,
    expiresAt: Date.now() + ((tokenData.expires_in || 3600) * 1000)
  };

  return bulkTokenStore.accessToken;
}

// Step 3: Kick off bulk export
// IMPORTANT: Bulk export kickoff uses root-level URL, NOT org-specific.
// Using org-specific URL (e.g., /v1/r4/47286/Group/...) incorrectly returns
// HTTP 200 with an empty FHIR searchset Bundle instead of starting a bulk job.
// The correct root-level URL: GET /v1/r4/Group/{groupId}/$export
//
// AdvancedMD returns:
//   - 202 (async): standard FHIR Bulk, Content-Location header has status URL
//   - 200 (sync): fallback/diagnostic — may indicate wrong URL or empty group
async function startBulkExport(accessToken) {
  const groupId = process.env.FHIR_GROUP_ID;

  // Root-level bulk export URL (no org segment)
  const exportUrl = `https://providerapi.advancedmd.com/v1/r4/Group/${groupId}/$export`;

  console.log('  Step 3: Starting bulk export...');
  console.log(`    URL: ${exportUrl}`);

  const response = await fetch(exportUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/fhir+json',
      'Prefer': 'respond-async',
      'OfficeKey': process.env.FHIR_PROVIDER_OFFICEKEY
    }
  });

  if (response.status === 202) {
    // Standard async bulk export
    const contentLocation = response.headers.get('content-location');
    const body = await response.text();
    let jobId;
    try {
      const parsed = JSON.parse(body);
      jobId = parsed.jobId || parsed.job_id;
    } catch (e) {
      const match = contentLocation?.match(/jobId=([^&]+)/) || contentLocation?.match(/\/([^\/]+)$/);
      jobId = match ? match[1] : null;
    }
    console.log(`    Export started (async). Job ID: ${jobId || 'unknown'}`);
    return { jobId, contentLocation, mode: 'async' };
  }

  if (response.status === 200) {
    // DIAGNOSTIC: If we get 200 with a Bundle, this may indicate:
    //   1. Wrong URL pattern (org-specific instead of root-level)
    //   2. Empty group returning a searchset Bundle
    //   3. AdvancedMD sync fallback mode
    // The correct root-level $export should return 202 for async processing.
    const body = await response.json();
    const dataServiceLinks = (body.link || [])
      .filter(l => l.relation === 'search' || l.relation === 'first')
      .map(l => l.url);
    console.log(`    WARNING: Got 200 instead of 202 (total: ${body.total || 0})`);
    console.log(`    This may indicate wrong URL pattern or empty group.`);
    if (dataServiceLinks.length) {
      console.log(`    Data service URL: ${dataServiceLinks[0]}`);
    }
    return { bundle: body, dataServiceLinks, mode: 'sync' };
  }

  const err = await response.text();
  throw new Error(`Export kickoff failed (${response.status}): ${err.substring(0, 300)}`);
}

// Step 4: Poll for export completion
// AdvancedMD status URL: https://providerapi.advancedmd.com/v1/fhir-bulk/status?groupId={groupId}&jobId={jobId}
// Returns 202 while in progress, 200 when complete with batchId/batchNumber for downloads.
async function pollExportStatus(accessToken, groupId, jobId, contentLocation = null) {
  const officeKey = process.env.FHIR_PROVIDER_OFFICEKEY;
  console.log('  Step 4: Polling export status...');

  // Use Content-Location if it's a full URL, otherwise build from env
  let statusBaseUrl;
  if (contentLocation && contentLocation.startsWith('http')) {
    statusBaseUrl = contentLocation;
  } else {
    const baseStatusUrl = process.env.FHIR_BULK_STATUS_URL || 'https://providerapi.advancedmd.com/v1/fhir-bulk/status';
    statusBaseUrl = `${baseStatusUrl}?groupId=${groupId}&jobId=${jobId}`;
  }

  console.log(`    Status URL: ${statusBaseUrl}`);

  const maxPolls = 60; // Max 5 minutes at 5s intervals
  for (let i = 0; i < maxPolls; i++) {
    const headers = { 'Authorization': `Bearer ${accessToken}` };
    if (officeKey) headers['OfficeKey'] = officeKey;

    const response = await fetch(statusBaseUrl, { headers });

    if (response.status === 200) {
      const result = await response.json();
      const batchId = result.batchId || result.batch || result.batchNumber;
      console.log(`    Export complete! Batch ID: ${batchId || 'unknown'}`);
      return result;
    }

    if (response.status === 202) {
      const bodyText = await response.text();
      let progress = 'In progress';
      try {
        const parsed = JSON.parse(bodyText);
        progress = parsed.status || parsed.message || progress;
      } catch (e) {
        progress = response.headers.get('x-progress') || progress;
      }
      console.log(`    ${progress}... (poll ${i + 1})`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }

    const err = await response.text();
    throw new Error(`Status check failed (${response.status}): ${err.substring(0, 300)}`);
  }

  throw new Error('Export timed out after 5 minutes');
}

// Step 5: Download resource data from manifest URLs or AdvancedMD bulk resource endpoint
// AdvancedMD documented bulk resource download path:
//   GET /v1/fhir-bulk/fhir-resource/{batchId}/{fhirEntity}
// The batchId comes from the completed status poll response.
async function downloadBulkData(accessToken, exportResult, resourceTypes) {
  const outputByType = getBulkOutputUrlsByType(exportResult);
  const batchId = exportResult?.batchId || exportResult?.batch || exportResult?.batchNumber || null;
  const dataServiceLinks = exportResult?.dataServiceLinks || [];
  const officeKey = process.env.FHIR_PROVIDER_OFFICEKEY;

  console.log(`  Step 5: Downloading resources...`);
  if (batchId) console.log(`    Batch ID: ${batchId}`);

  const rawData = {
    patients: [], conditions: [], procedures: [], encounters: [],
    observations: [], serviceRequests: [], medicationRequests: [],
    practitioners: [], locations: [], coverages: [], diagnosticReports: []
  };

  // Build download URLs per resource type
  const typeUrls = {};
  for (const type of resourceTypes) {
    if (outputByType[type]?.length) {
      // Standard FHIR bulk manifest URLs (from output array)
      typeUrls[type] = outputByType[type];
    } else if (batchId) {
      // AdvancedMD documented path: /v1/fhir-bulk/fhir-resource/{batchId}/{fhirEntity}
      typeUrls[type] = [`https://providerapi.advancedmd.com/v1/fhir-bulk/fhir-resource/${batchId}/${type}`];
    } else if (dataServiceLinks.length) {
      // Fallback: data-service links with _type parameter
      typeUrls[type] = dataServiceLinks.map(link => {
        const sep = link.includes('?') ? '&' : '?';
        return `${link}${sep}_type=${type}`;
      });
    }
  }

  for (const type of resourceTypes) {
    const urls = typeUrls[type] || [];

    if (!urls.length) {
      console.log(`    ${type}: no download URL available`);
      continue;
    }

    try {
      const key = type.charAt(0).toLowerCase() + type.slice(1) + 's';
      let totalForType = 0;

      for (const url of urls) {
        const headers = {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/fhir+ndjson, application/fhir+json, application/json'
        };
        // AdvancedMD bulk endpoints require OfficeKey header
        if (officeKey) headers['OfficeKey'] = officeKey;

        const response = await fetch(url, { headers });

        if (!response.ok) {
          console.log(`    ${type}: ${response.status} from ${url} (skipped)`);
          continue;
        }

        const contentType = response.headers.get('content-type') || '';
        const bodyText = await response.text();
        const resources = parseBulkPayload(bodyText, contentType, type);

        if (rawData[key]) {
          rawData[key].push(...resources);
        }

        totalForType += resources.length;
      }

      console.log(`    ${type}: ${totalForType} resources`);

      // Small pause between downloads
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.log(`    ${type}: error (${err.message})`);
    }
  }

  return rawData;
}

// Full automated bulk pipeline — one endpoint does everything
app.get('/api/bulk-pull', async (req, res) => {
  try {
    console.log('\n========================================');
    console.log('BULK EXPORT PIPELINE — Starting');
    console.log('========================================');
    const startTime = Date.now();

    // Step 1-2: Authenticate
    const accessToken = await getBulkToken();

    // Step 3: Kick off export
    const groupId = process.env.FHIR_GROUP_ID;
    const exportResult = await startBulkExport(accessToken);

    let exportManifest;

    if (exportResult.mode === 'async') {
      // Standard async flow: poll for completion
      if (!exportResult.jobId) {
        throw new Error('No job ID returned from async export kickoff');
      }
      exportManifest = await pollExportStatus(accessToken, groupId, exportResult.jobId, exportResult.contentLocation);
    } else {
      // AdvancedMD sync flow: use data-service links directly
      exportManifest = exportResult;
    }

    // Step 5: Download all resource types
    const resourceTypes = [
      'Patient', 'Condition', 'Procedure', 'Encounter',
      'Observation', 'ServiceRequest', 'MedicationRequest',
      'Practitioner', 'Location', 'Coverage', 'DiagnosticReport'
    ];
    const rawData = await downloadBulkData(accessToken, exportManifest, resourceTypes);

    // Step 6: Transform → deidentify → cache
    console.log('  Step 6: Transforming and de-identifying...');
    const metrics = transformToDatabase(rawData);
    const safeMetrics = deidentify(metrics);

    metricsCache = { data: safeMetrics, timestamp: Date.now() };

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n========================================`);
    console.log(`BULK EXPORT COMPLETE — ${elapsed}s`);
    console.log(`========================================\n`);

    res.json({
      dataSource: 'bulk-export',
      data: safeMetrics,
      fetchedIn: elapsed + 's'
    });
  } catch (err) {
    console.error('Bulk pipeline error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// DE-IDENTIFIED METRICS EXPORT
// ========================================
// Safe to save to disk — contains no PHI
// ========================================

app.get('/api/metrics/export', (req, res) => {
  if (!metricsCache.data) {
    return res.status(404).json({ error: 'No metrics available. Fetch dashboard data first.' });
  }

  res.setHeader('Content-Disposition', `attachment; filename=wce-metrics-${new Date().toISOString().split('T')[0]}.json`);
  res.json({
    exportedAt: new Date().toISOString(),
    dataSource: 'de-identified aggregate metrics',
    phiStatus: 'NONE — all patient identifiers removed',
    data: metricsCache.data
  });
});

// ========================================
// START SERVER
// ========================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   WCE Provider Intelligence Dashboard               ║
║   http://localhost:${PORT}                             ║
╠══════════════════════════════════════════════════════════╣
║                                                      ║
║   FHIR Base: ${(FHIR_BASE_URL || 'not configured').padEnd(39)}║
║   Mode: ${FHIR_MODE.toUpperCase().padEnd(44)}║
║                                                      ║
║   PHI Policy: NO persistent storage                  ║
║   • Raw FHIR data held in memory only                ║
║   • De-identified metrics cached in memory           ║
║   • Nothing written to disk                          ║
║                                                      ║
║   Endpoints:                                         ║
║     GET  /                    Dashboard              ║
║     GET  /auth/launch         Start OAuth             ║
║     GET  /api/auth/status     Connection status       ║
║     GET  /api/dashboard-data  Fetch & aggregate       ║
║     POST /api/bulk-export/start   Kick off bulk       ║
║     GET  /api/metrics/export  Download safe metrics   ║
║                                                      ║
╚══════════════════════════════════════════════════════════╝
  `);
});
