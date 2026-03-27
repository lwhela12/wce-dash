# AdvancedMD FHIR Authentication — Status & Findings

**Last updated:** 2026-03-26

## Goal

Authenticate with AdvancedMD's FHIR API to pull bulk patient data into the WCE Provider Intelligence Dashboard.

## App Registration (AdvancedMD Developer Portal)

- **App name:** WCE-Dashboard-Bulk
- **App ID:** 458569e8-44e1-47ac-8f4d-19ec2f6ec2b5
- **APIs enabled:**
  - FHIR Bulk JWKS API — Enabled
  - FHIR Bulk API — Enabled
  - FHIR Single Patient API — Not enabled (not needed)
- **JWKS public key:** Hosted on [GitHub Gist](https://gist.githubusercontent.com/lwhela12/9cfd6e22c7e2360e6def6f171cb9aad4/raw/jwks.json)
- **Private key:** `private-key.pem` (local, matches gist public key)

## What We Tried

### 1. Interactive OAuth (3-Legged) via `/v1/oauth2/authorize`

**Result: Blocked — app only has Bulk API access**

| Step | What happened |
|------|--------------|
| Scope `user/*.read` | Rejected: "Unsupported scopes" |
| Scope `patient/*.read` | Rejected: "Unsupported scopes" |
| Scope `user/Patient.read` (expanded) | Rejected: "Unsupported scopes" |
| Basic scopes only (`openid fhirUser offline_access online_access`) | Login flow completes through patient selection, then returns `INTERNAL_SERVER_ERROR` |

The INTERNAL_SERVER_ERROR occurs after AdvancedMD's patient selection screen, when it tries to redirect back with an auth code. Likely cause: the app is registered for Bulk API only and doesn't support the authorization code grant.

### 2. Standard Token Endpoint (`/v1/oauth2/token`) with `private_key_jwt`

**Result: Blocked — JWKS URL not registered**

Sent `client_credentials` grant with a self-signed JWT (`client_assertion`) per the SMART Backend Services spec.

- Error: **"Public key url is invalid"**
- The standard token endpoint requires the client's JWKS URL to be registered server-side by AdvancedMD. Our app doesn't have this configured.
- Adding `publickeyurl` as a body parameter does not work on this endpoint.

### 3. JWKS Token Endpoint (`/v1/fhir-jwks/token`) with `publickeyurl`

**Result: Closest to working — stuck on "invalid algorithm"**

This non-standard endpoint accepts a `publickeyurl` parameter, bypassing the need for pre-registration. Progression:

| Attempt | Auth method | Result |
|---------|------------|--------|
| No auth, form body only | 400 — "Public key url is invalid" |
| Added `publickeyurl` param | 401 — Unauthorized |
| Added Basic Auth (client_id:secret) | **400 — "invalid algorithm"** |
| Changed JWT from RS384 to RS256 | 400 — "invalid algorithm" |
| Removed `alg` from JWKS | 400 — "invalid algorithm" |
| Set `alg: RS256` in JWKS | 400 — "invalid algorithm" |
| Sent `algorithm=RS256` as body param | 400 — "invalid algorithm" |
| Sent `algorithm=RS384` as body param | 400 — "invalid algorithm" |
| Removed JWT entirely (no client_assertion) | 400 — "invalid algorithm" |

The "invalid algorithm" error persists regardless of what we change. This suggests the endpoint has a specific undocumented requirement we haven't met.

## SMART Configuration (from `.well-known/smart-configuration`)

```
Token endpoint: /v1/oauth2/token
Auth methods: client_secret_basic, client_secret_post, private_key_jwt
Signing algorithm: RS384
Grant types: authorization_code, client_credentials
Scopes: openid, fhirUser, offline_access, online_access,
         launch/patient, patient/*.read, patient/*.rs,
         user/*.read, user/*.rs
```

Note: The SMART config says `client_credentials` is supported at `/v1/oauth2/token`, but our app gets "Public key url is invalid" because the JWKS URL isn't registered for our client.

## What's Needed to Unblock

### Option A: Register JWKS URL with AdvancedMD (recommended)
Ask AdvancedMD support to associate our JWKS public key URL with our client ID on the standard `/v1/oauth2/token` endpoint. Once done, the existing `private_key_jwt` + `client_credentials` code in `server.js` should work as-is.

### Option B: Get `fhir-jwks/token` endpoint documentation
The portal's "FHIR Documentation" section should have specs for this endpoint, including valid `algorithm` values and the expected request format. This would unblock the dynamic JWKS URL approach.

### Option C: Get practice admin authorization for Bulk API
The FHIR Bulk API description in the portal says it "requires practice admin authorization." The WCEDASHBOARD account may need to be explicitly approved by the practice admin in AdvancedMD's system before bulk export works.

## Account Status

- **WCEDASHBOARD** (office key 153928) — **LOCKED** as of 2026-03-26 due to repeated failed auth attempts. Needs admin unlock.
- **FHIRTEST** (office key 991900) — AdvancedMD test account, working for login but not for bulk export.

## Current Code State

- `server.js` has both auth flows implemented (OAuth + Bulk JWT)
- The Bulk JWT flow (`getBulkToken()`) currently targets `/v1/fhir-jwks/token` with Basic Auth + `publickeyurl`
- The OAuth flow (`/auth/launch`) uses PKCE and basic scopes
- Dashboard falls back to synthetic data when auth fails
