// The admin's API. The site's content lives in the repo (src/data/
// dishes.json and regions.json): reading and saving go through GitHub, and a
// save is one commit on main, which publishes the site. Photos are resized
// in the browser and uploaded straight to the media bucket with signed URLs.
//
//   GET    state     both files and the commit they come from
//   PUT    state     saves them (409 if main moved on meanwhile)
//   POST   photo     signed URLs to upload one photo at 800 and 1600 px
//   GET    runs      the latest Deploy runs
//   GET    me        who is signed in
import { AwsClient } from 'aws4fetch';

interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // owner/name
  GITHUB_BRANCH?: string; // main; another branch to try the admin out
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_MEDIA_BUCKET?: string;
  PUBLIC_MEDIA_BASE: string;
}

type Ctx = { request: Request; env: Env; data: { email?: string }; params: { path?: string[] } };

const FILES = { dishes: 'src/data/dishes.json', regions: 'src/data/regions.json' } as const;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KINDS = ['plato', 'tapa', 'tecnica', 'dulce', 'bebida', 'producto'];
const TEXT_FIELDS = ['name', 'place', 'summary', 'description', 'origin', 'fact'] as const;
const PHOTO_KEY = /^platos\/[a-z0-9-]+\/\d+$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function github(env: Env, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sobremesa-admin',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new HttpError(502, `GitHub ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const branch = (env: Env) => env.GITHUB_BRANCH ?? 'main';
const head = async (env: Env) => ((await github(env, `/git/ref/heads/${branch(env)}`)) as any).object.sha as string;

async function readState(env: Env) {
  const sha = await head(env);
  const entries = await Promise.all(
    Object.entries(FILES).map(async ([name, path]) => {
      const file = (await github(env, `/contents/${path}?ref=${sha}`)) as any;
      const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
      return [name, JSON.parse(text)];
    }),
  );
  return { head: sha, mediaBase: env.PUBLIC_MEDIA_BASE, ...Object.fromEntries(entries) };
}

const isStrings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');

// Checks what the admin sends before it reaches the site's build.
function validate(state: any) {
  const { dishes, regions } = state ?? {};
  if (!Array.isArray(dishes) || !Array.isArray(regions)) throw new HttpError(400, 'Faltan datos');
  const regionSlugs = new Set<string>();
  for (const r of regions) {
    if (!SLUG.test(r.slug ?? '') || regionSlugs.has(r.slug)) throw new HttpError(400, `Región no válida o repetida: ${r.slug}`);
    if (typeof r.name !== 'string' || !r.name.trim() || typeof r.intro !== 'string') throw new HttpError(400, `${r.slug}: falta el nombre`);
    regionSlugs.add(r.slug);
  }
  const slugs = new Set<string>();
  for (const d of dishes) {
    if (!SLUG.test(d.slug ?? '') || slugs.has(d.slug)) throw new HttpError(400, `Dirección no válida o repetida: ${d.slug}`);
    slugs.add(d.slug);
    for (const f of TEXT_FIELDS) if (typeof d[f] !== 'string') throw new HttpError(400, `${d.slug}: falta ${f}`);
    if (!d.name.trim()) throw new HttpError(400, `${d.slug}: falta el nombre`);
    if (!KINDS.includes(d.kind)) throw new HttpError(400, `${d.name}: tipo no válido`);
    if (!isStrings(d.regions) || !d.regions.length) throw new HttpError(400, `${d.name}: elige al menos una región`);
    for (const r of d.regions) if (!regionSlugs.has(r)) throw new HttpError(400, `${d.name}: la región ${r} no existe`);
    if (!isStrings(d.tags)) throw new HttpError(400, `${d.name}: etiquetas no válidas`);
    if (typeof d.draft !== 'boolean') throw new HttpError(400, `${d.name}: falta borrador`);
    if (d.photo !== null) {
      const p = d.photo;
      if (!PHOTO_KEY.test(p?.key ?? '') || !(p.w > 0) || !(p.h > 0) || typeof p.alt !== 'string') throw new HttpError(400, `${d.name}: foto no válida`);
    }
    if (d.recipe !== null) {
      const r = d.recipe;
      if (typeof r?.serves !== 'string' || typeof r.time !== 'string' || typeof r.notes !== 'string' || !isStrings(r.ingredients) || !isStrings(r.steps))
        throw new HttpError(400, `${d.name}: receta no válida`);
    }
  }
}

async function saveState(env: Env, body: any, email: string) {
  validate(body);
  const current = await head(env);
  if (body.head !== current) throw new HttpError(409, 'La web ha cambiado mientras editabas. Recarga para ver la última versión.');
  const commit = (await github(env, `/git/commits/${current}`)) as any;
  const tree = (await github(env, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: Object.entries(FILES).map(([name, path]) => ({ path, mode: '100644', type: 'blob', content: JSON.stringify(body[name], null, 2) + '\n' })),
    }),
  })) as any;
  const message = String(body.message || 'Cambios desde el admin').slice(0, 200);
  const created = (await github(env, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: `${message}\n\nAdmin: ${email}`, tree: tree.sha, parents: [current] }),
  })) as any;
  await github(env, `/git/refs/heads/${branch(env)}`, { method: 'PATCH', body: JSON.stringify({ sha: created.sha }) });
  return { head: created.sha };
}

const r2 = (env: Env) => new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });

async function photoUrls(env: Env, body: any) {
  if (!SLUG.test(body?.slug ?? '')) throw new HttpError(400, 'Plato no válido');
  // A new key for every photo, so a replaced photo never shows from a cache.
  const key = `platos/${body.slug}/${Date.now()}`;
  const sign = async (width: number) => {
    const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_MEDIA_BUCKET ?? 'sobremesa-media'}/${key}-${width}.webp`);
    url.searchParams.set('X-Amz-Expires', '3600');
    const signed = await r2(env).sign(new Request(url, { method: 'PUT', headers: { 'Content-Type': 'image/webp' } }), { aws: { signQuery: true } });
    return signed.url;
  };
  return { key, urls: { 800: await sign(800), 1600: await sign(1600) } };
}

async function runs(env: Env) {
  const data = (await github(env, `/actions/runs?per_page=10&branch=${branch(env)}`)) as any;
  return data.workflow_runs
    .filter((r: any) => r.name === 'Deploy')
    .map((r: any) => ({ id: r.id, title: r.display_title, status: r.status, conclusion: r.conclusion, created: r.created_at, updated: r.updated_at, head: r.head_sha }));
}

export const onRequest = async ({ request, env, data, params }: Ctx) => {
  const route = (params.path ?? []).join('/');
  const body = ['POST', 'PUT'].includes(request.method) ? await request.json().catch(() => null) : null;
  try {
    let out: unknown;
    if (route === 'state' && request.method === 'GET') out = await readState(env);
    else if (route === 'state' && request.method === 'PUT') out = await saveState(env, body, data.email!);
    else if (route === 'photo' && request.method === 'POST') out = await photoUrls(env, body);
    else if (route === 'runs' && request.method === 'GET') out = await runs(env);
    else if (route === 'me' && request.method === 'GET') out = { email: data.email };
    else throw new HttpError(404, 'No existe');
    return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
};
