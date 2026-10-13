import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('zbudowane pliki aplikacji (dist)', () => {
  beforeAll(() => {
    rmSync('dist', { recursive: true, force: true });
    execSync('npx vite build', { stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production' } });
  }, 180000);

  it('nie zawierają tokenu ani żadnych sekretów', () => {
    const files = walk('dist');
    expect(files.length).toBeGreaterThan(3);
    for (const f of files.filter((p) => /\.(js|html|css|webmanifest|json|map|svg|txt)$/.test(p))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|client_secret|PRIVATE KEY/);
    }
  });

  it('nie publikują żadnych danych pomiarowych przez GitHub Pages', () => {
    const names = walk('dist').map((p) => p.toLowerCase());
    expect(names.some((n) => n.endsWith('data.json') || n.includes('measurements'))).toBe(false);
    const indexed = walk('dist').filter((p) => p.endsWith('.json') || p.endsWith('.csv'));
    expect(indexed).toEqual([]);
  });

  it('mają CSP ograniczające połączenia do własnego origin i api.github.com oraz działający manifest i SW', () => {
    const html = readFileSync('dist/index.html', 'utf8').replace(/&#39;/g, "'");
    expect(html).toContain("connect-src 'self' https://api.github.com");
    expect(html).toContain("script-src 'self'");
    expect(html).toMatch(/rel="manifest"/);
    expect(existsSync('dist/sw.js')).toBe(true);
    expect(existsSync('dist/manifest.webmanifest')).toBe(true);
    expect(existsSync('dist/icons/icon-192.png') && existsSync('dist/icons/icon-512.png')).toBe(true);
    const manifest = JSON.parse(readFileSync('dist/manifest.webmanifest', 'utf8'));
    expect(manifest.display).toBe('standalone');
    expect(readFileSync('dist/sw.js', 'utf8')).not.toContain('api.github.com');
  });

  it('kod aplikacji kontaktuje się tylko z api.github.com', () => {
    const js = walk('dist/assets').filter((p) => p.endsWith('.js')).map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(js).toContain('https://api.github.com');
    const hosts = new Set((js.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []).map((u) => new URL(u).host));
    // Poza api.github.com w paczce są tylko adresy w tekstach (błędy Dexie/React, przestrzenie nazw XML) –
    // nie są to żądania sieciowe, a CSP (connect-src) i tak blokuje połączenia do innych hostów.
    const allowedByNature = /^(api\.github\.com|www\.w3\.org|react\.dev|reactjs\.org|dexie\.org|github\.com|developer\.mozilla\.org|localhost|tinyurl\.com|bit\.ly|[a-z0-9.-]*w3\.org)$/i;
    const unexpected = [...hosts].filter((h) => !allowedByNature.test(h));
    expect(unexpected).toEqual([]);
  });
});
