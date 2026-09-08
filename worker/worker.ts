interface Env {
  BUCKET: R2Bucket;
  ANTHROPIC_API_KEY: string;
  API_TOKEN: string;   // wrangler secret - bearer token for /api/leads
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Password, X-Admin-Password, Authorization',
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

    // Move every pending lead from one project's inbox to another
    if (url.pathname === '/admin/inbox/move' && request.method === 'POST') {
      if (request.headers.get('X-Admin-Password') !== ADMIN_PASSWORD) {
        return json({ error: 'Invalid admin password' }, 401);
      }
      const { from, to } = await request.json() as { from: string; to: string };
      if (!from || !to) return json({ error: 'from and to hashes required' }, 400);

      const listed = await env.BUCKET.list({ prefix: `inbox/${from}/`, limit: 500 });
      const moved: string[] = [];
      for (const obj of listed.objects) {
        const o = await env.BUCKET.get(obj.key);
        if (!o) continue;
        const lead = await o.json() as Record<string, unknown>;
        // fresh key, so a name collision at the destination cannot overwrite
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        lead.id = id;
        await env.BUCKET.put(`inbox/${to}/${id}.json`, JSON.stringify(lead), {
          httpMetadata: { contentType: 'application/json' },
        });
        await env.BUCKET.delete(obj.key);
        moved.push(String(lead.name || ''));
      }
      return json({ moved: moved.length, names: moved });
    }

    // Debug: what is sitting in every project's agent inbox
    if (url.pathname === '/admin/inbox' && request.method === 'GET') {
      if (request.headers.get('X-Admin-Password') !== ADMIN_PASSWORD) {
        return json({ error: 'Invalid admin password' }, 401);
      }
      const listed = await env.BUCKET.list({ prefix: 'inbox/', limit: 500 });
      const items = await Promise.all(listed.objects.map(async obj => {
        try {
          const o = await env.BUCKET.get(obj.key);
          const lead = o ? await o.json() as Record<string, unknown> : null;
          return { key: obj.key, name: lead?.name, board: lead?.board, receivedAt: obj.uploaded.toISOString() };
        } catch { return { key: obj.key }; }
      }));
      return json({ count: items.length, items });
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

    /* ============================================================
     * Agent API - lets a ChatGPT Action post leads into a project.
     *
     * Leads are NOT written into the project blob: the browser PUTs
     * that object wholesale on every save, so an open tab would
     * silently overwrite anything we appended. Each lead is instead
     * written as its own object under inbox/<hash>/, which the app
     * drains and deletes. One object per lead also means concurrent
     * posts can never clobber each other.
     * ============================================================ */

    if (url.pathname === '/openapi.json') {
      return new Response(JSON.stringify(openApiSchema(url.origin), null, 2), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/leads' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!env.API_TOKEN || token !== env.API_TOKEN) {
        return json({ error: 'Unauthorized' }, 401);
      }

      let body: { project?: string; board?: number; leads?: LeadInput[]; lead?: LeadInput };
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Body must be JSON' }, 400);
      }

      const project = (body.project || '').trim();
      if (project.length < 4) {
        return json({ error: 'project is required (the Stiki project name, min 4 chars)' }, 400);
      }

      const incoming = body.leads || (body.lead ? [body.lead] : []);
      if (!Array.isArray(incoming) || incoming.length === 0) {
        return json({ error: 'Provide leads: [...] with at least one lead' }, 400);
      }
      if (incoming.length > 50) {
        return json({ error: 'Maximum 50 leads per request' }, 400);
      }

      const named = incoming.filter(l => l && typeof l.name === 'string' && l.name.trim());
      if (named.length === 0) {
        return json({ error: 'Every lead needs a name' }, 400);
      }

      const hash = await simpleHash(project);

      // Refuse unknown projects. Without this the worker happily creates an
      // inbox for a made-up name, the leads look accepted, and nothing ever
      // drains them - which is exactly how four leads went missing.
      const target = await env.BUCKET.head(`levitate-${hash}.json`);
      if (!target) {
        return json({
          error: `No Stiki project named "${project}". Check the exact project name in Stiki's settings and try again.`,
        }, 404);
      }

      const board = Number.isInteger(body.board) && body.board! >= 0 && body.board! <= 5 ? body.board! : 0;

      const accepted = await Promise.all(named.map(async (lead, i) => {
        const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
        const record = {
          id,
          board,
          receivedAt: Date.now(),
          name: str(lead.name),
          role: str(lead.role),
          company: str(lead.company),
          email: str(lead.email),
          phone: str(lead.phone),
          linkedin: str(lead.linkedin),
          website: str(lead.website),
          notes: str(lead.notes),
        };
        await env.BUCKET.put(`inbox/${hash}/${id}.json`, JSON.stringify(record), {
          httpMetadata: { contentType: 'application/json' },
        });
        return record.name;
      }));

      return json({ accepted: accepted.length, names: accepted, project });
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

    // Pending agent leads for this project
    if (url.pathname === '/api/inbox' && request.method === 'GET') {
      const listed = await env.BUCKET.list({ prefix: `inbox/${hash}/`, limit: 200 });
      const leads = await Promise.all(listed.objects.map(async obj => {
        try {
          const o = await env.BUCKET.get(obj.key);
          return o ? { key: obj.key, lead: await o.json() } : null;
        } catch { return null; }
      }));
      return json({ leads: leads.filter(Boolean) });
    }

    // The app calls this once it has merged them in
    if (url.pathname === '/api/inbox/ack' && request.method === 'POST') {
      let keys: string[] = [];
      try {
        const b = await request.json() as { keys?: string[] };
        keys = Array.isArray(b.keys) ? b.keys : [];
      } catch { /* empty ack is a no-op */ }
      const mine = keys.filter(k => typeof k === 'string' && k.startsWith(`inbox/${hash}/`));
      await Promise.all(mine.map(k => env.BUCKET.delete(k)));
      return json({ deleted: mine.length });
    }

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
            'anthropic-beta': 'web-search-2025-03-05',
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

interface LeadInput {
  name?: string;
  role?: string;
  company?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  website?: string;
  notes?: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 500) : '';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function simpleHash(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* OpenAPI 3.1 schema, imported by the ChatGPT Action builder via URL. */
function openApiSchema(origin: string) {
  const lead = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: "The person's full name. The only required field." },
      company: { type: 'string', description: 'Company they work for. Core field - always try to fill this.' },
      role: { type: 'string', description: 'Job title, e.g. Director, Chartered Accountant. Core field - always try to fill this.' },
      email: { type: 'string', description: 'Email address. Core field. Only include one you actually saw in a source; never guess or construct it from a pattern.' },
      phone: {
        type: 'string',
        description: 'Phone number. Core field. A New Zealand mobile is strongly preferred - these start 02 or +642. If you only have a landline or switchboard number, send it anyway but say so in notes.',
      },
      linkedin: {
        type: 'string',
        description: "LinkedIn profile URL. Core field. If you cannot find the real profile URL, do not leave it blank and do not guess a slug - send a Google search link instead, in the form https://www.google.com/search?q=NAME+COMPANY+linkedin with spaces as + signs. That gives Ben a clickable way to find them.",
      },
      website: { type: 'string', description: 'Company or personal website.' },
      notes: { type: 'string', description: 'Any context worth keeping: where they came from, why they matter, and any caveats about the contact details (e.g. landline not mobile, LinkedIn is a search link).' },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Stiki Leads',
      description: 'Send leads to a Stiki board. Core fields Ben wants for every lead: name, company, role, email, phone (NZ mobile preferred), and a LinkedIn URL or Google search link.',
      version: '1.0.0',
    },
    servers: [{ url: origin }],
    paths: {
      '/api/leads': {
        post: {
          operationId: 'addLeads',
          summary: 'Add one or more leads to a Stiki project board.',
          description: 'Creates a lead card per person. They appear on the board next time Stiki is open.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['project', 'leads'],
                  properties: {
                    project: { type: 'string', description: 'The Stiki project name to file these under.' },
                    board: {
                      type: 'integer', minimum: 0, maximum: 5, default: 0,
                      description: 'Which board: 0 Orange, 1 Yellow, 2 Green, 3 Blue, 4 Indigo, 5 Violet. Defaults to 0.',
                    },
                    leads: { type: 'array', minItems: 1, maxItems: 50, items: lead },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Leads accepted.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      accepted: { type: 'integer' },
                      names: { type: 'array', items: { type: 'string' } },
                      project: { type: 'string' },
                    },
                  },
                },
              },
            },
            '400': { description: 'Bad request.' },
            '401': { description: 'Bad or missing token.' },
          },
        },
      },
    },
  };
}
