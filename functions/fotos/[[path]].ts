// Photos from the PHOTOS bucket. A photo's key never changes once
// uploaded (a new photo gets a new key), so browsers may keep it for good.
type Env = { PHOTOS: { get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null> } };

export const onRequestGet = async ({ env, params }: { env: Env; params: { path?: string[] } }) => {
  const key = (params.path ?? []).join('/');
  if (!/^platos\/[a-z0-9-]+\/\d+-(800|1600)\.webp$/.test(key)) return new Response('No existe', { status: 404 });
  const photo = await env.PHOTOS.get(key);
  if (!photo) return new Response('No existe', { status: 404 });
  return new Response(photo.body, {
    headers: { 'Content-Type': photo.httpMetadata?.contentType ?? 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
};
