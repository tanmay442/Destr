export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    if (host === '169.254.169.254' || host === 'fd00::' || host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd')) return false;
    return true;
  } catch {
    return false;
  }
}
