interface Env {
  BUCKET: R2Bucket;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Password',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
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
