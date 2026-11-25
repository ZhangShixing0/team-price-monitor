// The public shop templates use goods.image for the merchant product thumbnail.
// Keep URLs as data; never allow executable schemes or embedded credentials.
export function normalizeProductImageUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.trim(), 'https://wzyp.cn/');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
