export async function fetchPage(url: string): Promise<{ text: string; url: string }> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are supported');
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': 'Scoutyon/1.0 Research Agent' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} when fetching ${url}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  let text: string;

  if (contentType.includes('text/html')) {
    const html = await response.text();
    text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8_000);
  } else {
    text = (await response.text()).slice(0, 8_000);
  }

  return { text, url };
}
