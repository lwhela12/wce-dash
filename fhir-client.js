/**
 * FHIR Client for AdvancedMD
 * Handles authenticated requests to the FHIR R4 API
 * Includes retry logic for 429 rate limiting
 */

class FHIRClient {
  constructor({ baseUrl, tokenUrl }) {
    this.baseUrl = baseUrl;
    this.tokenUrl = tokenUrl;
  }

  async read(resourceType, id, accessToken) {
    const url = `${this.baseUrl}/${resourceType}/${id}`;
    return this._request(url, accessToken);
  }

  async search(resourceType, params = {}, accessToken) {
    const queryString = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}/${resourceType}${queryString ? '?' + queryString : ''}`;
    return this._request(url, accessToken);
  }

  /**
   * Fetch everything in a single request using global search with _type
   * Returns an object keyed by resource type
   */
  async searchAllTypes(types, accessToken) {
    const allByType = {};
    for (const t of types) allByType[t] = [];

    let url = `${this.baseUrl}?_type=${types.join(',')}&_count=100`;
    let pageCount = 0;

    while (url) {
      const bundle = await this._request(url, accessToken);
      pageCount++;

      if (bundle.entry) {
        for (const entry of bundle.entry) {
          const r = entry.resource;
          if (r && allByType[r.resourceType] !== undefined) {
            allByType[r.resourceType].push(r);
          }
        }
      }

      const nextLink = bundle.link?.find(l => l.relation === 'next');
      url = nextLink?.url || null;

      if (pageCount >= 200) {
        console.warn(`[FHIR] Global search: hit 200-page cap`);
        break;
      }

      if (pageCount % 10 === 0) {
        const total = Object.values(allByType).reduce((s, a) => s + a.length, 0);
        console.log(`[FHIR] Page ${pageCount}... ${total} resources so far`);
      }
    }

    for (const [type, resources] of Object.entries(allByType)) {
      console.log(`[FHIR] ${type}: ${resources.length}`);
    }
    console.log(`[FHIR] Total: ${Object.values(allByType).reduce((s, a) => s + a.length, 0)} resources in ${pageCount} pages`);

    return allByType;
  }

  async searchAll(resourceType, params = {}, accessToken) {
    const allResources = [];
    const queryString = new URLSearchParams({ ...params, _count: '100' }).toString();
    let url = `${this.baseUrl}/${resourceType}?${queryString}`;
    let pageCount = 0;

    while (url) {
      const bundle = await this._request(url, accessToken);
      pageCount++;

      if (bundle.entry) {
        for (const entry of bundle.entry) {
          if (entry.resource) {
            allResources.push(entry.resource);
          }
        }
      }

      const nextLink = bundle.link?.find(l => l.relation === 'next');
      url = nextLink?.url || null;

      if (pageCount >= 50) {
        console.warn(`[FHIR] ${resourceType}: hit 50-page cap (${allResources.length} resources so far)`);
        break;
      }
    }

    console.log(`[FHIR] ${resourceType}: ${allResources.length} resources (${pageCount} page${pageCount > 1 ? 's' : ''})`);
    return allResources;
  }

  async _request(url, accessToken, retryCount = 0) {
    const MAX_RETRIES = 3;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json'
      }
    });

    // Handle rate limiting with retry
    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '2', 10);
      const waitMs = retryAfter * 1000 * (retryCount + 1); // exponential: 2s, 4s, 6s
      console.log(`[FHIR] 429 rate limited. Waiting ${waitMs / 1000}s before retry ${retryCount + 1}/${MAX_RETRIES}...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return this._request(url, accessToken, retryCount + 1);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[FHIR] ${response.status} error: ${errorBody.substring(0, 300)}`);
      const error = new Error(`FHIR ${response.status}: ${errorBody.substring(0, 500)}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }
}

module.exports = { FHIRClient };
