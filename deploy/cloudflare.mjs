// Sets up everything the published site needs on Cloudflare and GitHub.
// Safe to run again: each step finds what exists and updates it in place.
//
//   node deploy/cloudflare.mjs   media bucket and CORS, media address, Pages
//                                project, tokens, Access on /admin and the
//                                GitHub secrets
//
// It runs on Quique's personal Cloudflare account (the one the token belongs
// to). Until DOMAIN is set below, the site is at <project>.pages.dev and the
// photos at the bucket's r2.dev address; with DOMAIN, they move to it and
// media.<DOMAIN>.
//
// Needs two tokens in ~/.config/sobremesa/:
//   cloudflare-token  Account: Cloudflare Pages Edit, Workers R2 Storage Edit,
//                     Access: Apps and Policies Edit; User: API Tokens Edit
//                     (plus Zone: DNS Edit on DOMAIN once there is one). Only
//                     used here: it mints the two narrow tokens the site runs
//                     with (deploy and R2).
//   github-token      fine-grained, SrMonedero/sobremesa only: Contents read
//                     and write, Actions read. The admin saves with it.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'sobremesa';
// The site's domain, once it is a zone in this account.
const DOMAIN = null;
const BUCKET = 'sobremesa-media';
const REPO = 'SrMonedero/sobremesa';
// Who may open the admin. The rest of the site is public.
const ACCESS_APP = 'Sobremesa admin';
const ACCESS_POLICY = 'Sobremesa — editores';
const EMAILS = ['quiquealvarezmonedero@gmail.com', 'quique.alvarez@semantico.ai'];

const DIR = path.join(homedir(), '.config', 'sobremesa');
const secret = (name) => {
  const file = path.join(DIR, name);
  if (!existsSync(file)) throw new Error(`Missing ${file}`);
  return readFileSync(file, 'utf8').trim();
};
const TOKEN = secret('cloudflare-token');
const API = 'https://api.cloudflare.com/client/v4';

async function cf(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    const err = new Error(`${method} ${route}: ${JSON.stringify(data.errors ?? res.status)}`);
    err.status = res.status;
    err.codes = (data.errors ?? []).map((e) => e.code);
    throw err;
  }
  return data.result;
}
const step = (s) => console.log(`\n· ${s}`);

// Minted tokens are kept so the site's secrets survive a rerun; a token is
// shown only once, when it is created.
const MINTED = path.join(DIR, 'minted.json');
const minted = existsSync(MINTED) ? JSON.parse(readFileSync(MINTED, 'utf8')) : {};
const keep = () => writeFileSync(MINTED, JSON.stringify(minted, null, 2), { mode: 0o600 });

async function mint(name, policies) {
  if (minted[name]) {
    const live = await cf('GET', `/user/tokens/${minted[name].id}`).catch(() => null);
    if (live?.status === 'active') return minted[name];
  }
  const token = await cf('POST', '/user/tokens', { name, policies });
  minted[name] = { id: token.id, value: token.value };
  keep();
  console.log(`  minted ${name}`);
  return minted[name];
}

async function main() {
  const accounts = await cf('GET', '/accounts');
  if (accounts.length !== 1) throw new Error(`The token reaches ${accounts.length} accounts; it must reach only one`);
  const ACCOUNT = accounts[0].id;
  console.log(`Account: ${accounts[0].name}`);
  const zone = DOMAIN ? (await cf('GET', `/zones?name=${DOMAIN}`))[0] : null;
  if (DOMAIN && !zone) throw new Error(`Zone ${DOMAIN} not in this account`);

  step(`Pages project ${PROJECT}`);
  let project = await cf('GET', `/accounts/${ACCOUNT}/pages/projects/${PROJECT}`).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  if (project) console.log('  exists');
  else (project = await cf('POST', `/accounts/${ACCOUNT}/pages/projects`, { name: PROJECT, production_branch: 'main' })), console.log('  created');
  // pages.dev names are global: a taken name gets a suffix.
  const PAGES_DOMAIN = project.subdomain;
  console.log(`  ${PAGES_DOMAIN}`);
  const ADMIN_ORIGINS = [`https://${PAGES_DOMAIN}`, ...(DOMAIN ? [`https://${DOMAIN}`, `https://www.${DOMAIN}`] : [])];

  step(`R2 bucket ${BUCKET}`);
  const buckets = (await cf('GET', `/accounts/${ACCOUNT}/r2/buckets`)).buckets.map((b) => b.name);
  if (buckets.includes(BUCKET)) console.log('  exists');
  else await cf('POST', `/accounts/${ACCOUNT}/r2/buckets`, { name: BUCKET }), console.log('  created');

  step('Bucket CORS (the admin uploads photos straight from the browser)');
  await cf('PUT', `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/cors`, {
    rules: [{ allowed: { origins: ADMIN_ORIGINS, methods: ['PUT'], headers: ['content-type'] }, maxAgeSeconds: 3600 }],
  });

  let media;
  if (zone) {
    media = `media.${DOMAIN}`;
    step(`Media address ${media}`);
    const domains = (await cf('GET', `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/custom`)).domains ?? [];
    if (domains.some((d) => d.domain === media)) console.log('  exists');
    else await cf('POST', `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/custom`, { domain: media, zoneId: zone.id, enabled: true, minTLS: '1.2' });
  } else {
    step('Media address (the bucket\'s r2.dev, until there is a domain)');
    media = (await cf('PUT', `/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/managed`, { enabled: true })).domain;
  }
  const MEDIA_BASE = `https://${media}`;
  console.log(`  ${MEDIA_BASE}`);

  step('Tokens the site runs with');
  const groups = await cf('GET', '/user/tokens/permission_groups');
  const group = (name) => {
    const g = groups.find((x) => x.name === name);
    if (!g) throw new Error(`No permission group "${name}"`);
    return { id: g.id };
  };
  const deploy = await mint('sobremesa deploy (Pages)', [
    { effect: 'allow', resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: '*' }, permission_groups: [group('Pages Write')] },
  ]);
  const bucketResources = { [`com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_${BUCKET}`]: '*' };
  const r2 = await mint('sobremesa media (R2 objects)', [
    { effect: 'allow', resources: bucketResources, permission_groups: [group('Workers R2 Storage Bucket Item Write'), group('Workers R2 Storage Bucket Item Read')] },
  ]);
  // R2's S3 keys for a token: its id, and the SHA-256 of its value.
  const s3 = { id: r2.id, secret: createHash('sha256').update(r2.value).digest('hex') };

  step('Access');
  // The team domain, from the organization or (without the permission to
  // read it) from the WARP login app, which lives on it.
  const apps = await cf('GET', `/accounts/${ACCOUNT}/access/apps`);
  const team =
    (await cf('GET', `/accounts/${ACCOUNT}/access/organizations`).then((o) => o.auth_domain, () => null)) ??
    apps.map((a) => a.domain ?? '').find((d) => d.endsWith('.cloudflareaccess.com/warp'))?.replace(/\/warp$/, '');
  if (!team) throw new Error('No Access team domain found');
  console.log(`  team ${team}`);
  const include = EMAILS.map((email) => ({ email: { email } }));
  const policyBody = { name: ACCESS_POLICY, decision: 'allow', include, session_duration: '720h' };
  let policy = (await cf('GET', `/accounts/${ACCOUNT}/access/policies`)).find((p) => p.name === ACCESS_POLICY);
  policy = policy ? await cf('PUT', `/accounts/${ACCOUNT}/access/policies/${policy.id}`, policyBody) : await cf('POST', `/accounts/${ACCOUNT}/access/policies`, policyBody);
  // Only the admin and its API are private, on every address the site has
  // (each deployment also gets its own <hash>.<project>.pages.dev).
  const hosts = [PAGES_DOMAIN, `*.${PAGES_DOMAIN}`, ...(DOMAIN ? [DOMAIN, `www.${DOMAIN}`] : [])].flatMap((h) => [`${h}/admin`, `${h}/api/admin`]);
  const appBody = {
    name: ACCESS_APP,
    type: 'self_hosted',
    domain: hosts[0],
    self_hosted_domains: hosts,
    session_duration: '720h',
    app_launcher_visible: false,
    policies: [{ id: policy.id, precedence: 1 }],
  };
  let app = apps.find((a) => a.name === ACCESS_APP);
  app = app ? await cf('PUT', `/accounts/${ACCOUNT}/access/apps/${app.id}`, appBody) : await cf('POST', `/accounts/${ACCOUNT}/access/apps`, appBody);
  console.log(`  ${app.name}: ${app.self_hosted_domains.join(', ')}`);

  step('Pages settings');
  const github = secret('github-token');
  const env = {
    GITHUB_REPO: { type: 'plain_text', value: REPO },
    GITHUB_TOKEN: { type: 'secret_text', value: github },
    R2_ACCOUNT_ID: { type: 'plain_text', value: ACCOUNT },
    R2_ACCESS_KEY_ID: { type: 'secret_text', value: s3.id },
    R2_MEDIA_BUCKET: { type: 'plain_text', value: BUCKET },
    R2_SECRET_ACCESS_KEY: { type: 'secret_text', value: s3.secret },
    PUBLIC_MEDIA_BASE: { type: 'plain_text', value: MEDIA_BASE },
    ACCESS_TEAM: { type: 'plain_text', value: team },
    ACCESS_AUD: { type: 'plain_text', value: app.aud },
  };
  const config = { env_vars: env, compatibility_date: '2026-11-01' };
  await cf('PATCH', `/accounts/${ACCOUNT}/pages/projects/${PROJECT}`, { deployment_configs: { production: config, preview: config } });

  step('GitHub secrets and variables for the workflows');
  const gh = (args, input) => execFileSync('gh', args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
  gh(['secret', 'set', 'CLOUDFLARE_API_TOKEN', '--repo', REPO], deploy.value);
  gh(['variable', 'set', 'CLOUDFLARE_ACCOUNT_ID', '--repo', REPO, '--body', ACCOUNT]);
  gh(['variable', 'set', 'PAGES_PROJECT', '--repo', REPO, '--body', PROJECT]);
  gh(['variable', 'set', 'MEDIA_BASE', '--repo', REPO, '--body', MEDIA_BASE]);

  if (zone) {
    step(`${DOMAIN} and www.${DOMAIN} → Pages`);
    const attached = await cf('GET', `/accounts/${ACCOUNT}/pages/projects/${PROJECT}/domains`);
    for (const name of [DOMAIN, `www.${DOMAIN}`]) {
      if (!attached.some((d) => d.name === name)) await cf('POST', `/accounts/${ACCOUNT}/pages/projects/${PROJECT}/domains`, { name });
      const [record] = await cf('GET', `/zones/${zone.id}/dns_records?name=${name}`);
      const body = { type: 'CNAME', name, content: PAGES_DOMAIN, proxied: true, comment: 'Sobremesa on Cloudflare Pages' };
      if (record && record.content !== PAGES_DOMAIN) throw new Error(`${name} points at ${record.content}: check it before replacing it`);
      if (!record) await cf('POST', `/zones/${zone.id}/dns_records`, body);
      console.log(`  ${name} CNAME ${PAGES_DOMAIN}`);
    }
  }
  console.log('\nDone.');
}

await main();
