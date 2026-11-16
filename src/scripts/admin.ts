// The admin: edits dishes.json and regions.json in the browser and publishes
// them as one commit through /api/admin. Nothing is saved until "Publicar".
import type { Dish, Region, Photo } from '../lib/site';

const KINDS: Record<string, string> = { plato: 'Plato', tapa: 'Tapa', tecnica: 'Técnica', dulce: 'Dulce', bebida: 'Bebida', producto: 'Producto' };
const WIDTHS = [800, 1600] as const;

type State = { head: string; mediaBase: string; dishes: Dish[]; regions: Region[] };
type Run = { id: number; status: string; conclusion: string | null; head: string; updated: string };

let state: State;
let original = { dishes: new Map<string, string>(), regions: '' };
let view: 'dishes' | 'regions' = 'dishes';
let selected: string | null = null;
let query = '';
let email = '';
let busy = false;
let confirmDelete = false;
let message: { kind: 'ok' | 'err'; text: string } | null = null;
let publishing: string | null = null; // the commit being deployed
let lastRun: Run | null = null;
let photoStatus = '';

const app = document.getElementById('app')!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const collator = new Intl.Collator('es');
const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ñ/g, 'n').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api/admin/${path}`, { ...init, headers: init.body ? { 'Content-Type': 'application/json' } : {} });
  const data = await res.json().catch(() => ({ error: `Error ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Error ${res.status}`), { status: res.status });
  return data;
}

function snapshot() {
  original = { dishes: new Map(state.dishes.map((d) => [d.slug, JSON.stringify(d)])), regions: JSON.stringify(state.regions) };
}
const current = () => state.dishes.find((d) => d.slug === selected) ?? null;
const isNew = (d: Dish) => !original.dishes.has(d.slug);
const changedDishes = () => state.dishes.filter((d) => original.dishes.get(d.slug) !== JSON.stringify(d));
const deletedDishes = () => [...original.dishes.keys()].filter((s) => !state.dishes.some((d) => d.slug === s));
const regionsChanged = () => original.regions !== JSON.stringify(state.regions);
const pending = () => changedDishes().length + deletedDishes().length + (regionsChanged() ? 1 : 0);
const regionName = (slug: string) => state.regions.find((r) => r.slug === slug)?.name ?? slug;

function commitMessage() {
  const parts: string[] = [];
  const changed = changedDishes();
  const created = changed.filter(isNew).map((d) => d.name);
  const edited = changed.filter((d) => !isNew(d)).map((d) => d.name);
  const deleted = deletedDishes().map((s) => JSON.parse(original.dishes.get(s)!).name);
  if (created.length) parts.push(`Añade ${created.join(', ')}`);
  if (edited.length) parts.push(`Edita ${edited.join(', ')}`);
  if (deleted.length) parts.push(`Quita ${deleted.join(', ')}`);
  if (regionsChanged()) parts.push('Edita regiones');
  return parts.join('. ') || 'Cambios desde el admin';
}

// ── Rendering ────────────────────────────────────────────────

function statusHtml() {
  const n = pending();
  if (publishing) {
    const r = lastRun && lastRun.head === publishing ? lastRun : null;
    if (r?.status === 'completed' && r.conclusion !== 'success') return `<span class="dot err"></span>La publicación ha fallado. Vuelve a intentarlo o avísame.`;
    return `<span class="dot run"></span>Publicando… tarda un par de minutos`;
  }
  if (n) return `<span class="dot run"></span>${n} ${n === 1 ? 'cambio sin publicar' : 'cambios sin publicar'}`;
  if (lastRun?.status === 'completed' && lastRun.conclusion !== 'success') return `<span class="dot err"></span>La última publicación falló`;
  return `<span class="dot ok"></span>Todo publicado`;
}

function render() {
  const n = pending();
  app.innerHTML = `
    <header class="bar">
      <h1>Sobremesa</h1>
      <a class="btn ghost small" href="/" target="_blank" rel="noopener">Ver la web</a>
      <span class="spacer"></span>
      <span class="status" id="status">${statusHtml()}</span>
      <span class="who">${esc(email)}</span>
      <button class="btn primary" id="publish" ${!n || busy ? 'disabled' : ''}>${busy ? 'Publicando…' : 'Publicar cambios'}</button>
    </header>
    <div class="main">
      <aside class="side">
        <div class="tabs" role="tablist">
          <button role="tab" data-view="dishes" aria-selected="${view === 'dishes'}">Platos <span class="badge">${state.dishes.length}</span></button>
          <button role="tab" data-view="regions" aria-selected="${view === 'regions'}">Regiones</button>
        </div>
        ${view === 'dishes' ? `
          <div class="tools">
            <input type="search" id="q" placeholder="Buscar plato o región" aria-label="Buscar plato o región" value="${esc(query)}" />
            <button class="btn" id="new">Nuevo plato</button>
          </div>
          <ul class="list">${listHtml()}</ul>` : '<div></div><div></div>'}
      </aside>
      <main class="editor">
        ${message ? `<p class="msg ${message.kind}">${esc(message.text)}</p>` : ''}
        ${view === 'regions' ? regionsHtml() : editorHtml()}
      </main>
    </div>`;
}

function listHtml() {
  const words = slugify(query).split('-').filter(Boolean);
  const list = [...state.dishes]
    .filter((d) => {
      const hay = slugify(`${d.name} ${d.regions.map(regionName).join(' ')} ${d.tags.join(' ')}`);
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => collator.compare(a.name || '~', b.name || '~'));
  if (!list.length) return `<li class="empty" style="padding:16px">Ningún plato coincide.</li>`;
  return list
    .map((d) => {
      const badges = [
        isNew(d) ? '<span class="badge new">Nuevo</span>' : original.dishes.get(d.slug) !== JSON.stringify(d) ? '<span class="badge new">Editado</span>' : '',
        d.draft ? '<span class="badge warn">Borrador</span>' : '',
        d.photo ? '' : '<span class="badge">Sin foto</span>',
        d.recipe ? '<span class="badge">Receta</span>' : '',
      ].join('');
      return `<li><button data-dish="${esc(d.slug)}" aria-current="${d.slug === selected}">
        <span class="name">${esc(d.name || 'Sin nombre')}</span>
        <span class="sub">${esc(d.regions.map(regionName).join(', ') || 'Sin región')} · ${KINDS[d.kind]}</span>
        <span class="badges">${badges}</span>
      </button></li>`;
    })
    .join('');
}

function editorHtml() {
  const d = current();
  if (!d) return `<p class="empty">Elige un plato de la lista o crea uno nuevo.</p>`;
  const r = d.recipe;
  const photoSrc = d.photo ? `${state.mediaBase}/${d.photo.key}-800.webp` : '';
  return `
  <form id="dish" autocomplete="off">
    <div class="head">
      <h2>${esc(d.name || 'Plato nuevo')}</h2>
      <span class="spacer"></span>
      ${!isNew(d) && !d.draft ? `<a class="btn small" href="/plato/${esc(d.slug)}/" target="_blank" rel="noopener">Ver en la web</a>` : ''}
      <button type="button" class="btn ghost small" id="delete">Eliminar</button>
    </div>
    ${confirmDelete ? `<div class="confirm">¿Eliminar «${esc(d.name)}»? Desaparecerá de la web al publicar.
      <button type="button" class="btn danger small" id="delete-yes">Eliminar</button>
      <button type="button" class="btn ghost small" id="delete-no">Cancelar</button></div>` : ''}

    <fieldset>
      <legend>Plato</legend>
      <label class="field"><span>Nombre</span><input type="text" id="f-name" name="name" value="${esc(d.name)}" required /></label>
      <p class="help">Dirección: /plato/${esc(d.slug || '…')}/${isNew(d) ? ' (sale del nombre)' : ''}</p>
      <div class="row">
        <label class="field"><span>Tipo</span><select id="f-kind" name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>Lugar concreto (opcional)</span><input type="text" id="f-place" name="place" value="${esc(d.place)}" placeholder="Alt Camp, Tarragona" /></label>
      </div>
      <div class="field"><span>Regiones</span>
        <div class="checks">${state.regions.map((g) => `<label class="check"><input type="checkbox" name="region" value="${g.slug}" ${d.regions.includes(g.slug) ? 'checked' : ''} />${esc(g.name)}</label>`).join('')}</div>
      </div>
      <label class="field"><span>Etiquetas</span><input type="text" id="f-tags" name="tags" value="${esc(d.tags.join(', '))}" placeholder="legumbre, cuchara, invierno" /></label>
      <p class="help">Separadas por comas.</p>
      <label class="check"><input type="checkbox" id="f-draft" name="draft" ${d.draft ? 'checked' : ''} />Borrador: no sale en la web</label>
    </fieldset>

    <fieldset>
      <legend>Textos</legend>
      <label class="field"><span>Resumen</span><input type="text" id="f-summary" name="summary" value="${esc(d.summary)}" /></label>
      <p class="help">Una línea. Sale bajo el nombre y en las tarjetas.</p>
      <label class="field"><span>Qué es</span><textarea id="f-description" name="description" class="tall">${esc(d.description)}</textarea></label>
      <label class="field"><span>De dónde viene</span><textarea id="f-origin" name="origin">${esc(d.origin)}</textarea></label>
      <label class="field"><span>Curiosidad</span><textarea id="f-fact" name="fact">${esc(d.fact)}</textarea></label>
    </fieldset>

    <fieldset>
      <legend>Foto</legend>
      <div class="photo">
        <div class="preview">${photoSrc ? `<img src="${esc(photoSrc)}" alt="" />` : photoStatus ? esc(photoStatus) : 'Sin foto'}</div>
        <div class="actions">
          <div class="head">
            <label class="btn">${d.photo ? 'Cambiar foto' : 'Subir foto'}<input type="file" id="f-photo" accept="image/*" hidden /></label>
            ${d.photo ? '<button type="button" class="btn ghost" id="photo-remove">Quitar</button>' : ''}
          </div>
          ${photoStatus && photoSrc ? `<p class="help">${esc(photoStatus)}</p>` : ''}
          ${d.photo ? `<label class="field"><span>Descripción de la foto</span><input type="text" id="f-alt" name="alt" value="${esc(d.photo.alt)}" placeholder="Cazuela de barro con bacalao al pilpil" /></label>
          <p class="help">Para quien no ve la imagen.</p>` : '<p class="help">JPG, PNG, WEBP o HEIC. Se reduce y se convierte a WEBP antes de subir.</p>'}
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Receta</legend>
      <label class="check"><input type="checkbox" id="f-has-recipe" name="hasRecipe" ${r ? 'checked' : ''} />Este plato tiene receta</label>
      ${r ? `
      <div class="row">
        <label class="field"><span>Raciones</span><input type="text" id="f-serves" name="serves" value="${esc(r.serves)}" placeholder="4" /></label>
        <label class="field"><span>Tiempo</span><input type="text" id="f-time" name="time" value="${esc(r.time)}" placeholder="45 min" /></label>
      </div>
      <label class="field"><span>Ingredientes</span><textarea id="f-ingredients" name="ingredients" class="tall">${esc(r.ingredients.join('\n'))}</textarea></label>
      <p class="help">Uno por línea.</p>
      <label class="field"><span>Pasos</span><textarea id="f-steps" name="steps" class="tall">${esc(r.steps.join('\n'))}</textarea></label>
      <p class="help">Uno por línea; se numeran solos.</p>
      <label class="field"><span>Notas</span><textarea id="f-notes" name="notes">${esc(r.notes)}</textarea></label>` : ''}
    </fieldset>
  </form>`;
}

function regionsHtml() {
  const count = (slug: string) => state.dishes.filter((d) => d.regions.includes(slug)).length;
  return `<div class="regions-edit">
    <h2>Regiones</h2>
    <p class="help">La introducción sale arriba en la página de cada región. Puede quedarse vacía.</p>
    <div>${state.regions
      .map(
        (r, i) => `<div class="region-row">
        <span class="rname">${esc(r.name)} <small>${count(r.slug)} platos · /region/${esc(r.slug)}/</small></span>
        <label class="field"><span class="help">Introducción</span><textarea data-region="${i}" id="r-${esc(r.slug)}">${esc(r.intro)}</textarea></label>
      </div>`,
      )
      .join('')}</div>
  </div>`;
}

// Re-renders only what a keystroke changes, so the field keeps its focus.
function refreshChrome() {
  const status = document.getElementById('status');
  if (status) status.innerHTML = statusHtml();
  const publish = document.getElementById('publish') as HTMLButtonElement | null;
  if (publish) publish.disabled = !pending() || busy;
  const list = document.querySelector('.list');
  if (list) list.innerHTML = listHtml();
  const title = document.querySelector('.editor h2');
  const d = current();
  if (title && d && view === 'dishes') title.textContent = d.name || 'Plato nuevo';
}

// ── Editing ──────────────────────────────────────────────────

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function readForm() {
  const d = current();
  const form = document.getElementById('dish') as HTMLFormElement | null;
  if (!d || !form) return;
  const f = new FormData(form);
  const text = (k: string) => String(f.get(k) ?? '').trim();
  d.name = text('name');
  if (isNew(d)) {
    const before = d.slug;
    let slug = slugify(d.name) || before;
    if (slug !== before && state.dishes.some((x) => x !== d && x.slug === slug)) slug = `${slug}-${state.dishes.length}`;
    d.slug = slug;
    selected = slug;
    const help = form.querySelector('.help');
    if (help) help.textContent = `Dirección: /plato/${slug || '…'}/ (sale del nombre)`;
  }
  d.kind = (text('kind') || 'plato') as Dish['kind'];
  d.place = text('place');
  d.regions = state.regions.map((r) => r.slug).filter((s) => f.getAll('region').includes(s));
  d.tags = text('tags').split(',').map((t) => t.trim()).filter(Boolean);
  d.draft = f.get('draft') === 'on';
  d.summary = text('summary');
  d.description = text('description');
  d.origin = text('origin');
  d.fact = text('fact');
  if (d.photo && f.has('alt')) d.photo.alt = text('alt');
  if (d.recipe && f.has('serves')) {
    d.recipe = { serves: text('serves'), time: text('time'), ingredients: lines(String(f.get('ingredients') ?? '')), steps: lines(String(f.get('steps') ?? '')), notes: text('notes') };
  }
}

function newDish() {
  let slug = 'plato-nuevo';
  for (let i = 2; state.dishes.some((d) => d.slug === slug); i++) slug = `plato-nuevo-${i}`;
  const d: Dish = { slug, name: '', kind: 'plato', regions: [], place: '', summary: '', description: '', origin: '', fact: '', tags: [], photo: null, recipe: null, draft: true };
  state.dishes.push(d);
  selected = slug;
  query = '';
  message = null;
  render();
  (document.getElementById('f-name') as HTMLInputElement)?.focus();
}

// Photos are decoded and resized here, then uploaded at two widths.
async function webp(bitmap: ImageBitmap, width: number) {
  const scale = Math.min(1, width / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/webp', 0.84));
  if (!blob || blob.type !== 'image/webp') throw new Error('Este navegador no puede crear WEBP. Prueba con Chrome, Firefox o Safari reciente.');
  return { blob, w: canvas.width, h: canvas.height };
}

async function uploadPhoto(file: File) {
  const d = current();
  if (!d) return;
  if (!d.name) return (message = { kind: 'err', text: 'Ponle nombre al plato antes de subir la foto.' }), render();
  const slug = d.slug;
  photoStatus = 'Preparando la foto…';
  render();
  try {
    const bitmap = await createImageBitmap(file).catch(() => {
      throw new Error('No se puede leer esta imagen. Si es HEIC, ábrela en Safari o expórtala como JPG.');
    });
    const sizes = await Promise.all(WIDTHS.map((w) => webp(bitmap, w)));
    photoStatus = 'Subiendo…';
    render();
    const { key, urls } = await api('photo', { method: 'POST', body: JSON.stringify({ slug }) });
    await Promise.all(
      WIDTHS.map(async (w, i) => {
        const res = await fetch(urls[w], { method: 'PUT', body: sizes[i].blob, headers: { 'Content-Type': 'image/webp' } });
        if (!res.ok) throw new Error(`La subida ha fallado (${res.status}).`);
      }),
    );
    const big = sizes[1];
    const photo: Photo = { key, w: big.w, h: big.h, alt: d.photo?.alt ?? '' };
    const target = state.dishes.find((x) => x.slug === slug) ?? d;
    target.photo = photo;
    photoStatus = 'Foto lista. Sale en la web al publicar.';
  } catch (e) {
    photoStatus = '';
    message = { kind: 'err', text: (e as Error).message };
  }
  render();
}

async function publish() {
  if (busy || !pending()) return;
  const invalid = state.dishes.find((d) => !d.name.trim() || !d.regions.length);
  if (invalid) {
    selected = invalid.slug;
    view = 'dishes';
    message = { kind: 'err', text: `«${invalid.name || 'Plato nuevo'}» necesita nombre y al menos una región antes de publicar.` };
    return render();
  }
  busy = true;
  message = null;
  render();
  try {
    const { head } = await api('state', { method: 'PUT', body: JSON.stringify({ head: state.head, message: commitMessage(), dishes: state.dishes, regions: state.regions }) });
    state.head = head;
    publishing = head;
    snapshot();
    message = { kind: 'ok', text: 'Guardado. La web se está actualizando y estará lista en un par de minutos.' };
    pollRuns();
  } catch (e) {
    message = { kind: 'err', text: (e as Error).message };
  }
  busy = false;
  render();
}

async function pollRuns() {
  try {
    const runs: Run[] = await api('runs');
    lastRun = (publishing && runs.find((r) => r.head === publishing)) || runs[0] || null;
    if (publishing && lastRun?.head === publishing && lastRun.status === 'completed') {
      if (lastRun.conclusion === 'success') message = { kind: 'ok', text: 'Publicado. Los cambios ya están en la web.' };
      publishing = null;
      render();
      return;
    }
    refreshChrome();
  } catch {
    // The status is a convenience; editing goes on without it.
  }
  if (publishing) setTimeout(pollRuns, 6000);
}

// ── Events ───────────────────────────────────────────────────

app.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('button, [data-view]') as HTMLElement | null;
  if (!t) return;
  if (t.dataset.view) {
    view = t.dataset.view as typeof view;
    message = null;
    return render();
  }
  if (t.dataset.dish) {
    selected = t.dataset.dish;
    confirmDelete = false;
    photoStatus = '';
    message = null;
    render();
    document.querySelector('.editor')?.scrollTo(0, 0);
    return;
  }
  switch (t.id) {
    case 'new': return newDish();
    case 'publish': return void publish();
    case 'delete': confirmDelete = true; return render();
    case 'delete-no': confirmDelete = false; return render();
    case 'delete-yes':
      state.dishes = state.dishes.filter((d) => d.slug !== selected);
      selected = null;
      confirmDelete = false;
      return render();
    case 'photo-remove': {
      const d = current();
      if (d) d.photo = null;
      photoStatus = '';
      return render();
    }
  }
});

app.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'q') {
    query = t.value;
    const list = document.querySelector('.list');
    if (list) list.innerHTML = listHtml();
    return;
  }
  if (t.dataset.region !== undefined) {
    state.regions[Number(t.dataset.region)].intro = t.value.trim();
    return refreshChrome();
  }
  if (t.closest('#dish') && t.type !== 'file') {
    readForm();
    refreshChrome();
  }
});

app.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'f-photo' && t.files?.[0]) return void uploadPhoto(t.files[0]);
  if (t.id === 'f-has-recipe') {
    const d = current();
    if (!d) return;
    d.recipe = t.checked ? { serves: '', time: '', ingredients: [], steps: [], notes: '' } : null;
    return render();
  }
  if (t.closest('#dish') && (t.type === 'checkbox' || t.tagName === 'SELECT')) {
    readForm();
    refreshChrome();
  }
});

app.addEventListener('submit', (e) => e.preventDefault());

window.addEventListener('beforeunload', (e) => {
  if (pending()) e.preventDefault();
});

// ── Start ────────────────────────────────────────────────────

(async () => {
  try {
    const [me, data] = await Promise.all([api('me'), api('state')]);
    email = me.email;
    state = data;
    snapshot();
    render();
    pollRuns();
  } catch (e) {
    app.innerHTML = `<div class="loading"><p class="msg err">${esc((e as Error).message)}</p><p>Si acabas de entrar, recarga la página.</p></div>`;
  }
})();
