interface Env {
  BUCKET: R2Bucket;
  ANTHROPIC_API_KEY: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Password, X-Admin-Password',
};

const ADMIN_PASSWORD = 'Benny123';

const N8N_WEBHOOK = 'https://n8n.tui.bridgepoint.cloud/webhook/7203731c-bba3-4879-98c3-32cdf91e9997';
const N8N_AUTH = 'Basic bjhuOkVfUlRGckZKISpqZS1Bd1paYk5FMlo0ckh3dVY=';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Admin endpoints
    if (url.pathname === '/admin/list') {
      const adminPw = request.headers.get('X-Admin-Password');
      if (adminPw !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: 'Invalid admin password' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      // List all levitate files in bucket with card counts
      const listed = await env.BUCKET.list({ prefix: 'levitate-' });
      const projects = await Promise.all(listed.objects.map(async obj => {
        let cardCount = 0;
        try {
          const data = await env.BUCKET.get(obj.key);
          if (data) {
            const json = await data.json() as { notes?: unknown[] };
            cardCount = json.notes?.length || 0;
          }
        } catch {}
        return {
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded.toISOString(),
          cardCount,
        };
      }));

      return new Response(JSON.stringify({ projects }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/admin/delete' && request.method === 'DELETE') {
      const adminPw = request.headers.get('X-Admin-Password');
      if (adminPw !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: 'Invalid admin password' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const { key } = await request.json() as { key: string };
      if (!key || !key.startsWith('levitate-')) {
        return new Response(JSON.stringify({ error: 'Invalid key' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      await env.BUCKET.delete(key);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/admin/view' && request.method === 'GET') {
      const adminPw = request.headers.get('X-Admin-Password');
      if (adminPw !== ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: 'Invalid admin password' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const key = url.searchParams.get('key');
      if (!key || !key.startsWith('levitate-')) {
        return new Response(JSON.stringify({ error: 'Invalid key' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const object = await env.BUCKET.get(key);
      if (!object) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const data = await object.text();
      return new Response(data, {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const password = request.headers.get('X-Sync-Password');

    if (!password || password.length < 4) {
      return new Response(JSON.stringify({ error: 'Password required (min 4 chars)' }), {
        status: 401,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Simple hash for filename - not crypto secure but prevents guessing
    const hash = await simpleHash(password);
    const filename = `levitate-${hash}.json`;

    if (request.method === 'GET') {
      // Load data
      const object = await env.BUCKET.get(filename);
      if (!object) {
        return new Response(JSON.stringify({ error: 'No data found' }), {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      const data = await object.text();
      return new Response(data, {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Search for LinkedIn profiles using Claude web search
    if (request.method === 'POST' && url.pathname === '/search') {
      try {
        const { location, industry, role } = await request.json() as { location?: string; industry?: string; role?: string };

        const searchQuery = `Find 10 ${role || 'business professionals'}${industry ? ` in the ${industry} industry` : ''}${location ? ` located in ${location}` : ''}. I need their full names, job titles, company names, and LinkedIn profile URLs. Return as JSON array.`;

        const searchResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4096,
            tools: [{
              type: 'web_search_20250305',
              name: 'web_search',
              max_uses: 10,
            }],
            messages: [{
              role: 'user',
              content: `Find ${role || 'professionals'}${industry ? ` in ${industry}` : ''}${location ? ` in ${location}` : ''}.

Search and return as many people as you can find (aim for 5-10).

Output format - respond with ONLY this JSON, nothing else before or after:
[
  {"name": "Full Name", "role": "Job Title", "company": "Company Name", "linkedin": "linkedin.com/in/username"}
]

Start your response with [ and end with ]`,
            }],
          }),
        });

        if (!searchResponse.ok) {
          const err = await searchResponse.text();
          return new Response(JSON.stringify({ error: 'Search API error', details: err }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        const searchResult = await searchResponse.json() as { content: Array<{ type: string; text?: string }> };
        console.log('Claude response:', JSON.stringify(searchResult));

        const textBlocks = searchResult.content.filter((c) => c.type === 'text');
        const searchText = textBlocks[textBlocks.length - 1]?.text || '';
        console.log('Extracted text:', searchText);

        // Extract JSON array from response - find opening [ and matching closing ]
        const startIdx = searchText.indexOf('[');
        const endIdx = searchText.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
          return new Response(JSON.stringify({ profiles: [], error: 'No profiles found', debug: searchText.substring(0, 500) }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        const jsonStr = searchText.substring(startIdx, endIdx + 1);
        let profiles: Array<{ name: string; role: string; company: string; linkedin: string }>;
        try {
          profiles = JSON.parse(jsonStr);
        } catch {
          return new Response(JSON.stringify({ profiles: [], error: 'Invalid JSON', debug: jsonStr.substring(0, 500) }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ profiles }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Search failed', details: String(e) }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    // Enrich company URL via n8n webhook
    if (request.method === 'POST' && url.pathname === '/enrich-url') {
      try {
        const { url: companyUrl } = await request.json() as { url: string };

        if (!companyUrl) {
          return new Response(JSON.stringify({ error: 'URL required' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        // Extract domain from URL
        let domain = companyUrl;
        try {
          const parsed = new URL(companyUrl.startsWith('http') ? companyUrl : `https://${companyUrl}`);
          domain = parsed.hostname.replace(/^www\./, '');
        } catch {
          domain = companyUrl.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
        }

        // Call n8n webhook to enrich
        const n8nResponse = await fetch(N8N_WEBHOOK, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': N8N_AUTH,
          },
          body: JSON.stringify({
            company_name: '',
            website: domain,
            industry: '',
            email_address: '',
          }),
        });

        if (!n8nResponse.ok) {
          return new Response(JSON.stringify({ error: 'Enrichment failed' }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        const rawData = await n8nResponse.json() as Record<string, unknown>;
        const data = (rawData.output || rawData) as Record<string, string>;

        return new Response(JSON.stringify({
          name: data['Contact Name'] || '',
          role: data['Contact Role'] || '',
          company: data.company || data.Company || '',
          industry: data.industry || data.Industry || '',
          phone: data.phone || data.Phone || '',
          email: data.email || data.Email || '',
          website: `https://${domain}`,
        }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Enrichment failed', details: String(e) }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/scan') {
      // Scan LinkedIn screenshot with Claude Vision
      try {
        const { image } = await request.json() as { image: string };
        if (!image) {
          return new Response(JSON.stringify({ error: 'No image provided' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        // Extract base64 data (remove data URL prefix if present)
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        const mediaType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

        // Step 1: Extract name, role, company from screenshot
        const visionResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64Data,
                  },
                },
                {
                  type: 'text',
                  text: `Extract from this LinkedIn screenshot. JSON only:
{"name":"Full Name","role":"Job Title","company":"Company Name","location":"City, Country"}`,
                },
              ],
            }],
          }),
        });

        if (!visionResponse.ok) {
          const err = await visionResponse.text();
          return new Response(JSON.stringify({ error: 'Vision API error', details: err }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        const visionResult = await visionResponse.json() as { content: Array<{ type: string; text?: string }> };
        const visionText = visionResult.content.find((c) => c.type === 'text')?.text || '';
        const jsonMatch = visionText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return new Response(JSON.stringify({ error: 'Could not parse vision response' }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        const profile = JSON.parse(jsonMatch[0]) as { name: string; role: string; company: string; location?: string };

        // Step 2: Find company website using web search
        let phone = '';
        let website = '';
        let email = '';
        if (profile.company) {
          try {
            // First, find the website
            const searchResponse = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 256,
                tools: [{
                  type: 'web_search_20250305',
                  name: 'web_search',
                  max_uses: 1,
                }],
                messages: [{
                  role: 'user',
                  content: `Find the official website for "${profile.company}"${profile.location ? ` in ${profile.location}` : ''}. Return ONLY the domain (e.g., example.com), nothing else.`,
                }],
              }),
            });

            if (searchResponse.ok) {
              const searchResult = await searchResponse.json() as { content: Array<{ type: string; text?: string }> };
              // Get the LAST text block - web search returns multiple content items
              const textBlocks = searchResult.content.filter((c) => c.type === 'text');
              const searchText = textBlocks[textBlocks.length - 1]?.text || '';
              // Extract domain
              const urlMatch = searchText.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z.]+)/);
              if (urlMatch) {
                const domain = urlMatch[1].replace(/^www\./, '');
                website = `https://${domain}`;

                // Step 3: Call N8N webhook to enrich with contact details
                try {
                  const n8nResponse = await fetch(N8N_WEBHOOK, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': N8N_AUTH,
                    },
                    body: JSON.stringify({
                      company_name: profile.company,
                      website: domain,
                      industry: '',
                      email_address: '',
                    }),
                  });

                  if (n8nResponse.ok) {
                    const rawData = await n8nResponse.json() as Record<string, unknown>;
                    const data = (rawData.output || rawData) as Record<string, string>;
                    if (data.phone || data.Phone) phone = data.phone || data.Phone || '';
                    if (data.email || data.Email) email = data.email || data.Email || '';
                  }
                } catch (e) {
                  // N8N enrichment failed, continue with just website
                }
              }
            }
          } catch (e) {
            // Lookup failed, continue without it
          }
        }

        return new Response(JSON.stringify({
          name: profile.name || '',
          role: profile.role || '',
          company: profile.company || '',
          phone: phone,
          website: website,
          email: email,
        }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Scan failed', details: String(e) }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    if (request.method === 'POST') {
      // Save data
      try {
        const data = await request.json();
        await env.BUCKET.put(filename, JSON.stringify(data), {
          httpMetadata: { contentType: 'application/json' },
        });
        return new Response(JSON.stringify({ success: true, filename }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Failed to save' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  },
};

async function simpleHash(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
