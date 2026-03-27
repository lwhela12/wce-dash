# AdvancedMD FHIR Authentication — Status & Findings

**Last updated:** 2026-03-27

## Goal

Authenticate with AdvancedMD's FHIR API to pull bulk patient data into the WCE Provider Intelligence Dashboard.

## App Registration (AdvancedMD Developer Portal)

- **App name:** WCE-Dashboard-Bulk
- **App ID:** 458569e8-44e1-47ac-8f4d-19ec2f6ec2b5
- **API Key:** `HGKOE4OQ7rRK3OWJghoiNf27XAdqLWyWT1s9C1OfcuJ9ku7t`
- **APIs enabled:**
  - FHIR Bulk JWKS API — Enabled
  - FHIR Bulk API — Enabled
  - FHIR Single Patient API — Not enabled (not needed)
- **JWKS public key:** Hosted on [GitHub Gist](https://gist.githubusercontent.com/lwhela12/9cfd6e22c7e2360e6def6f171cb9aad4/raw/jwks.json)
- **Private key:** `private_key.pem` (local, RSA 2048-bit, matches gist public key)
- **JWT signing algorithm:** RS384

## Current Status: Blocked — JWKS URL Registration Required

### What works
- App is registered and API keys are active
- JWT assertion is correctly formatted per SMART Backend Services spec
- Key pair (private_key.pem + jwks.json gist) is valid and matching
- Standard `/v1/oauth2/token` endpoint correctly validates our JWT format
- Code in `server.js` implements the full SMART Backend Services flow

### What's blocking us
The standard token endpoint returns **"Public key url is invalid"** because AdvancedMD has not registered our JWKS URL server-side. This is a one-time admin step that only AdvancedMD can do.

## What We Tried

### 1. Interactive OAuth (3-Legged) via `/v1/oauth2/authorize`

**Result: Blocked — app only has Bulk API access**

| Step | What happened |
|------|--------------|
| Scope `user/*.read` | Rejected: "Unsupported scopes" |
| Scope `patient/*.read` | Rejected: "Unsupported scopes" |
| Basic scopes only (`openid fhirUser offline_access online_access`) | Login completes through patient selection, then `INTERNAL_SERVER_ERROR` on redirect |

### 2. Standard Token Endpoint (`/v1/oauth2/token`) with `private_key_jwt`

**Result: JWT validates correctly, but JWKS URL not registered**

- Sends `client_credentials` grant with RS384-signed JWT (`client_assertion`) per SMART Backend Services spec
- Error: **"Public key url is invalid"**
- The endpoint requires AdvancedMD to pre-register the client's JWKS URL server-side
- Adding `publickeyurl` as a body parameter does not work on this endpoint
- This is the correct endpoint — just needs the registration step

### 3. JWKS Token Endpoint (`/v1/fhir-jwks/token`) — CONFIRMED BROKEN

**Result: Endpoint returns "invalid algorithm" for ALL requests**

Exhaustive testing (2026-03-27) confirmed this endpoint is broken or misconfigured:

| Test | Result |
|------|--------|
| Bare minimum: just Basic Auth + `grant_type=client_credentials` | 400 — "invalid algorithm" |
| + RS384 JWT as `client_assertion` | 400 — "invalid algorithm" |
| + RS256 JWT as `client_assertion` | 400 — "invalid algorithm" |
| + HS256 JWT (HMAC with client secret) | 400 — "invalid algorithm" |
| + JWT as Bearer token | 401 — Unauthorized |
| + JWT in X-JWT header | 400 — "invalid algorithm" |
| + `publickeyurl` param | 400 — "invalid algorithm" |
| + `algorithm=RS384` param | 400 — "invalid algorithm" |
| + username/password/officekey | 400 — "invalid algorithm" |
| + App ID instead of API Key | 400 — "invalid algorithm" |
| JSON body instead of form-encoded | 400 — "Invalid grant type" |
| No body at all | 400 — "Invalid grant type" |
| GET request | 404 — "Unknown request" |
| No Basic Auth | 401 — Unauthorized |

**Conclusion:** The "invalid algorithm" error fires immediately after grant_type validation, before any body parameters are processed. This is an Apigee proxy-level error, not a client-side issue.

## SMART Configuration (from `.well-known/smart-configuration`)

```
Token endpoint:    https://providerapi.advancedmd.com/v1/oauth2/token
Auth endpoint:     https://providerapi.advancedmd.com/v1/oauth2/authorize
JWKS URI:          https://providerapi.advancedmd.com/v1/oauth2/.well-known/jwks.json
Auth methods:      client_secret_basic, private_key_jwt
Signing algorithm: RS384
Grant types:       authorization_code, client_credentials
```

## Action Required: Register JWKS URL

Contact AdvancedMD InterOps support to register our JWKS public key URL with our client ID:

- **Support page:** https://www.advancedmd.com/support/interoperability/
- **Request:** Associate JWKS URL with client for `/v1/oauth2/token` endpoint
- **JWKS URL:** `https://gist.githubusercontent.com/lwhela12/9cfd6e22c7e2360e6def6f171cb9aad4/raw/jwks.json`
- **Client ID (API Key):** `HGKOE4OQ7rRK3OWJghoiNf27XAdqLWyWT1s9C1OfcuJ9ku7t`
- **App ID:** `458569e8-44e1-47ac-8f4d-19ec2f6ec2b5`
- **Algorithm:** RS384

Once registered, the existing code in `server.js` (`getBulkToken()`) should work immediately — it already implements the correct SMART Backend Services flow.

Also ask about:
- Practice admin authorization for bulk export (may be required separately)
- Whether the WCEDASHBOARD account (office key 153928) can be unlocked
- Whether the `/v1/fhir-jwks/token` endpoint is still supported or deprecated

## Account Status

- **WCEDASHBOARD** (office key 153928) — **LOCKED** as of 2026-03-26 due to repeated failed auth attempts
- **FHIRTEST** (office key 991900) — AdvancedMD test account, working for login

## Current Code State

- `server.js` `getBulkToken()` targets `/v1/oauth2/token` with SMART Backend Services `client_assertion` flow
- JWT signed with RS384, includes `jku` header pointing to JWKS gist
- OAuth flow (`/auth/launch`) uses PKCE and basic scopes
- Dashboard falls back to synthetic data when auth fails
- New RSA key pair generated 2026-03-27 (private_key.pem + updated gist)
