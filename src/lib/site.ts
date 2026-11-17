// The site's content: src/data/dishes.json and regions.json, edited from
// /admin. Drafts stay out of the published pages.
import dishesData from '../data/dishes.json';
import regionsData from '../data/regions.json';

export type Photo = { key: string; w: number; h: number; alt: string };
export type Recipe = { serves: string; time: string; ingredients: string[]; steps: string[]; notes: string };
export type Dish = {
  slug: string;
  name: string;
  kind: keyof typeof KINDS;
  regions: string[];
  place: string;
  summary: string;
  description: string;
  origin: string;
  fact: string;
  tags: string[];
  photo: Photo | null;
  recipe: Recipe | null;
  draft: boolean;
};
export type Region = { slug: string; name: string; intro: string };

export const KINDS = { plato: 'Plato', tapa: 'Tapa', tecnica: 'Técnica', dulce: 'Dulce', bebida: 'Bebida', producto: 'Producto' } as const;

const collator = new Intl.Collator('es');
export const regions = regionsData as Region[];
export const dishes = (dishesData as Dish[]).filter((d) => !d.draft).sort((a, b) => collator.compare(a.name, b.name));
export const region = (slug: string) => regions.find((r) => r.slug === slug);
export const dishesIn = (slug: string) => dishes.filter((d) => d.regions.includes(slug));
export const regionNames = (d: Dish) => d.regions.map((s) => region(s)?.name ?? s);

// Each photo is stored at two widths, made in the admin before upload, and
// served by functions/fotos from the PHOTOS bucket.
const MEDIA = '/fotos';
export const photoUrl = (p: Photo, width: 800 | 1600) => `${MEDIA}/${p.key}-${width}.webp`;
export const photoSrcset = (p: Photo) => `${photoUrl(p, 800)} 800w, ${photoUrl(p, 1600)} 1600w`;
