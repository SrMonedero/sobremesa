// Every admin call must come through Cloudflare Access: the Access app in
// front of /admin signs a JWT (Cf-Access-Jwt-Assertion) that is checked here
// against the team's keys, so the API stays closed even on the pages.dev
// address, which Access does not cover.
interface Env {
  ACCESS_TEAM: string; // e.g. quique.cloudflareaccess.com
  ACCESS_AUD: string; // the Access apps' audience tags, comma separated
  ACCESS_DEV_EMAIL?: string; // `wrangler pages dev` only: who you are locally
}

type Jwk = JsonWebKey & { kid: string };
let keys: { at: number; list: Jwk[] } | undefined;

async function teamKeys(team: string): Promise<Jwk[]> {
  if (keys && Date.now() - keys.at < 3600_000) return keys.list;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: ${res.status}`);
  keys = { at: Date.now(), list: ((await res.json()) as { keys: Jwk[] }).keys };
  return keys.list;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function verify(token: string, env: Env): Promise<string | null> {
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const header = JSON.parse(new TextDecoder().decode(b64url(head)));
  const jwk = (await teamKeys(env.ACCESS_TEAM)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${head}.${body}`));
  if (!ok) return null;
  const claims = JSON.parse(new TextDecoder().decode(b64url(body)));
  const auds: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const allowed = env.ACCESS_AUD.split(',').map((a) => a.trim());
  if (!auds.some((a) => allowed.includes(a))) return null;
  if (claims.iss !== `https://${env.ACCESS_TEAM}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
  return claims.email ?? null;
}

export const onRequest = async (ctx: { request: Request; env: Env; data: Record<string, unknown>; next: () => Promise<Response> }) => {
  const { hostname } = new URL(ctx.request.url);
  // On Quique's Mac the admin is open on localhost only: anything that came
  // through Cloudflare (the tunnel) carries Cf-Ray and still needs Access.
  const local = (hostname === 'localhost' || hostname === '127.0.0.1') && !ctx.request.headers.has('Cf-Ray');
  if (ctx.env.ACCESS_DEV_EMAIL && local) {
    ctx.data.email = ctx.env.ACCESS_DEV_EMAIL;
    return ctx.next();
  }
  const token = ctx.request.headers.get('Cf-Access-Jwt-Assertion');
  const email = token ? await verify(token, ctx.env).catch(() => null) : null;
  if (!email) return Response.json({ error: 'No autorizado' }, { status: 401 });
  ctx.data.email = email;
  return ctx.next();
};
