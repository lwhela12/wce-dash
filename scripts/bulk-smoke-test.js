require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function createClientAssertion(tokenUrl) {
  const privateKey = fs.readFileSync(path.join(__dirname, '..', 'private_key.pem'), 'utf8');
  const clientId = requiredEnv('FHIR_CLIENT_ID_BULK');

  return jwt.sign({
    iss: clientId,
    sub: clientId,
    aud: tokenUrl,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: crypto.randomUUID()
  }, privateKey, {
    algorithm: 'RS384',
    header: {
      kid: 'wce-dashboard-bulk-1',
      typ: 'JWT',
      jku: requiredEnv('FHIR_JWKS_PUBLIC_URL')
    }
  });
}

function redactSensitiveBody(text) {
  return text.replace(/("access_token"\s*:\s*")([^"]+)(")/g, '$1[REDACTED]$3');
}

async function postForm(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers
    },
    body: new URLSearchParams(body)
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    body: redactSensitiveBody(text.trim()).slice(0, 1200),
    rawBody: text.trim()
  };
}

async function testStandardTokenEndpoint() {
  const tokenUrl = requiredEnv('FHIR_TOKEN_URL');
  const clientAssertion = createClientAssertion(tokenUrl);

  // AdvancedMD requires provider credentials (username/password/officekey)
  // in addition to the JWT client_assertion — hybrid auth, not pure SMART Backend Services
  const username = process.env.FHIR_PROVIDER_USERNAME || '';
  const password = process.env.FHIR_PROVIDER_PASSWORD || '';
  const officeKey = process.env.FHIR_PROVIDER_OFFICEKEY || '';

  const body = {
    grant_type: 'client_credentials',
    scope: 'system/*.read',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion
  };

  if (username) body.username = username;
  if (password) body.password = password;
  if (officeKey) body.officekey = officeKey;

  return {
    name: 'standard-token-endpoint',
    endpoint: tokenUrl,
    ...await postForm(tokenUrl, body)
  };
}

async function testDynamicJwksEndpoint() {
  const tokenUrl = requiredEnv('FHIR_JWKS_TOKEN_URL');
  const basicAuth = Buffer.from(
    `${requiredEnv('FHIR_CLIENT_ID_BULK')}:${requiredEnv('FHIR_CLIENT_SECRET_BULK')}`
  ).toString('base64');

  return {
    name: 'dynamic-jwks-endpoint',
    endpoint: tokenUrl,
    ...await postForm(tokenUrl, {
      grant_type: 'client_credentials'
    }, {
      Authorization: `Basic ${basicAuth}`
    })
  };
}

async function testBulkKickoff(accessToken) {
  const groupId = requiredEnv('FHIR_GROUP_ID');

  // IMPORTANT: Bulk export kickoff uses root-level URL, NOT org-specific.
  // Using org-specific URL (e.g., /v1/r4/47286/Group/...) incorrectly returns
  // HTTP 200 with an empty FHIR searchset Bundle instead of starting a bulk job.
  // The correct root-level URL returns HTTP 202 + Content-Location for async polling.
  const exportUrl = `https://providerapi.advancedmd.com/v1/r4/Group/${groupId}/$export`;

  const response = await fetch(exportUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/fhir+json',
      Prefer: 'respond-async',
      OfficeKey: requiredEnv('FHIR_PROVIDER_OFFICEKEY')
    }
  });

  const contentLocation = response.headers.get('content-location');
  const text = await response.text();

  // Expected responses from root-level bulk export URL:
  //   202: Async bulk job started, Content-Location has status URL
  //   409: Another job already running (correct URL, just need to wait)
  //   200: Sync fallback or wrong URL pattern (org-specific returns empty Bundle)
  const isSuccess = response.status === 202 || response.status === 409;
  const result = {
    name: 'bulk-export-kickoff',
    endpoint: exportUrl,
    ok: isSuccess,
    status: response.status,
    contentLocation,
    body: text.trim().slice(0, 1200)
  };

  if (response.status === 202) {
    result.summary = 'Async bulk job started successfully';
    // Extract jobId from Content-Location for reference
    const jobIdMatch = contentLocation?.match(/jobId=([^&]+)/);
    if (jobIdMatch) result.jobId = jobIdMatch[1];
  } else if (response.status === 409) {
    result.summary = 'Job already running — URL is correct, wait for current job to complete';
  } else if (response.status === 200) {
    result.summary = 'Got 200 instead of 202 — may be sync fallback or wrong URL pattern';
  }

  return result;
}

async function main() {
  const fullMode = process.argv.includes('--full');
  const results = {
    ranAt: new Date().toISOString(),
    mode: process.env.FHIR_MODE || 'test',
    officeKey: process.env.FHIR_PROVIDER_OFFICEKEY || '[missing]',
    username: process.env.FHIR_PROVIDER_USERNAME || '[missing]',
    tests: []
  };

  const standard = await testStandardTokenEndpoint();
  const standardRawBody = standard.rawBody;
  delete standard.rawBody;
  results.tests.push(standard);

  const dynamic = await testDynamicJwksEndpoint();
  delete dynamic.rawBody;
  results.tests.push(dynamic);

  if (fullMode && standard.ok) {
    try {
      const tokenPayload = JSON.parse(standardRawBody);
      const kickoff = await testBulkKickoff(tokenPayload.access_token);
      results.tests.push(kickoff);
    } catch (error) {
      results.tests.push({
        name: 'bulk-export-kickoff',
        ok: false,
        status: 0,
        body: `Unable to run kickoff test: ${error.message}`
      });
    }
  }

  const jwksBlocked = standard.body.includes('Public key url is invalid');
  const dynamicBroken = dynamic.body.toLowerCase().includes('invalid algorithm');

  results.summary = jwksBlocked
    ? 'Blocked on AdvancedMD JWKS URL registration at the standard token endpoint.'
    : standard.ok
      ? 'Standard token endpoint accepted the client assertion.'
      : 'Standard token endpoint failed for a reason other than JWKS registration.';

  if (dynamicBroken) {
    results.summary += ' Dynamic JWKS endpoint still returns "invalid algorithm" to a minimal request.';
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(standard.ok ? 0 : 1);
}

main().catch(error => {
  console.error(JSON.stringify({
    ranAt: new Date().toISOString(),
    error: error.message
  }, null, 2));
  process.exit(1);
});
