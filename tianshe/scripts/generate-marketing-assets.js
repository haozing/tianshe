#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const repoRoot = path.resolve(__dirname, '..');
const docsAssets = path.join(repoRoot, 'docs', 'assets');
const brandDir = path.join(docsAssets, 'brand');
const screenshotsDir = path.join(docsAssets, 'screenshots');
const heroDir = path.join(docsAssets, 'hero');
const socialDir = path.join(docsAssets, 'social');
const diagramsDir = path.join(docsAssets, 'diagrams');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const readDataUri = (file) => {
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return `data:${mime};base64,${buffer.toString('base64')}`;
};

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const renderSvgToPng = async (svg, outputPath, width, height) => {
  await sharp(Buffer.from(svg))
    .resize(width, height, { fit: 'fill' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outputPath);
};

const screenshotCard = ({ href, x, y, width, height, rotate = 0, opacity = 1 }) => `
  <g transform="translate(${x} ${y}) rotate(${rotate})" opacity="${opacity}">
    <rect x="0" y="0" width="${width}" height="${height}" rx="28" fill="#081118" stroke="#D1FAE5" stroke-opacity="0.22"/>
    <image x="12" y="12" width="${width - 24}" height="${height - 24}" preserveAspectRatio="xMidYMid slice" href="${href}"/>
  </g>`;

const featurePill = ({ x, y, text }) => `
  <g transform="translate(${x} ${y})">
    <rect x="0" y="0" width="${Math.max(128, text.length * 9 + 42)}" height="42" rx="21" fill="#ECFEFF" fill-opacity="0.08" stroke="#A7F3D0" stroke-opacity="0.18"/>
    <circle cx="22" cy="21" r="5" fill="#A3E635"/>
    <text x="38" y="27" fill="#D1FAE5" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="17" font-weight="700">${esc(text)}</text>
  </g>`;

const architectureNode = ({ x, y, w, h, title, body, accent = '#2DD4BF' }) => `
  <g transform="translate(${x} ${y})">
    <rect x="0" y="0" width="${w}" height="${h}" rx="18" fill="#0D1720" stroke="${accent}" stroke-opacity="0.38"/>
    <rect x="18" y="18" width="42" height="42" rx="12" fill="${accent}" fill-opacity="0.2"/>
    <circle cx="39" cy="39" r="8" fill="${accent}"/>
    <text x="78" y="37" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="26" font-weight="800">${esc(title)}</text>
    <text x="78" y="66" fill="#A7B4C2" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="16" font-weight="600">${esc(body)}</text>
  </g>`;

async function generateHero() {
  const logo = readDataUri(path.join(brandDir, 'tianshe-mark.svg'));
  const datasets = readDataUri(path.join(screenshotsDir, 'datasets.png'));
  const marketplace = readDataUri(path.join(screenshotsDir, 'plugin-market.png'));
  const settings = readDataUri(path.join(screenshotsDir, 'settings.png'));

  const width = 1600;
  const height = 900;
  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="108" y1="60" x2="1394" y2="884" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0B2530"/>
      <stop offset="0.48" stop-color="#081118"/>
      <stop offset="1" stop-color="#151814"/>
    </linearGradient>
    <radialGradient id="a" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(275 178) rotate(43) scale(740)">
      <stop stop-color="#2DD4BF" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#2DD4BF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="b" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1270 780) rotate(-132) scale(700)">
      <stop stop-color="#F8C65B" stop-opacity="0.26"/>
      <stop offset="1" stop-color="#F8C65B" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="34" stdDeviation="42" flood-color="#000000" flood-opacity="0.48"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" rx="48" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" rx="48" fill="url(#a)"/>
  <rect width="${width}" height="${height}" rx="48" fill="url(#b)"/>
  <path d="M104 252H1500M104 450H1500M104 648H1500" stroke="#FFFFFF" stroke-opacity="0.045" stroke-width="2"/>
  <path d="M286 78V822M572 78V822M858 78V822M1144 78V822" stroke="#FFFFFF" stroke-opacity="0.045" stroke-width="2"/>

  <g filter="url(#shadow)">
    ${screenshotCard({ href: settings, x: 910, y: 72, width: 560, height: 350, rotate: 2, opacity: 0.82 })}
    ${screenshotCard({ href: marketplace, x: 812, y: 306, width: 620, height: 392, rotate: -3, opacity: 0.92 })}
    ${screenshotCard({ href: datasets, x: 640, y: 166, width: 690, height: 430, rotate: 0, opacity: 1 })}
  </g>

  <image x="114" y="118" width="94" height="94" href="${logo}"/>
  <text x="234" y="162" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="42" font-weight="850">Tianshe</text>
  <text x="236" y="200" fill="#A7F3D0" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="2.6">LOCAL AI AUTOMATION RUNTIME</text>

  <text x="112" y="332" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="76" font-weight="850">Real tools for</text>
  <text x="112" y="414" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="76" font-weight="850">AI agents.</text>
  <text x="112" y="488" fill="#A7B4C2" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="28" font-weight="600">Browser profiles, local datasets, trusted plugins,</text>
  <text x="112" y="528" fill="#A7B4C2" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="28" font-weight="600">and HTTP/MCP orchestration in one desktop runtime.</text>

  ${featurePill({ x: 112, y: 612, text: 'Local-first' })}
  ${featurePill({ x: 270, y: 612, text: 'Electron + DuckDB' })}
  ${featurePill({ x: 492, y: 612, text: 'Trusted plugins' })}
  ${featurePill({ x: 112, y: 672, text: 'HTTP / MCP APIs' })}
  ${featurePill({ x: 300, y: 672, text: 'Visible automation' })}
</svg>`;

  await renderSvgToPng(svg, path.join(heroDir, 'tianshe-hero.png'), width, height);
}

async function generateSocial() {
  const logo = readDataUri(path.join(brandDir, 'tianshe-mark.svg'));
  const screenshot = readDataUri(path.join(screenshotsDir, 'plugin-market.png'));
  const width = 1280;
  const height = 640;
  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="68" y1="32" x2="1160" y2="610" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0D2A32"/>
      <stop offset="0.58" stop-color="#081118"/>
      <stop offset="1" stop-color="#181A13"/>
    </linearGradient>
    <filter id="shadow"><feDropShadow dx="0" dy="26" stdDeviation="34" flood-color="#000000" flood-opacity="0.5"/></filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="150" cy="110" r="360" fill="#2DD4BF" fill-opacity="0.18"/>
  <circle cx="1180" cy="620" r="430" fill="#F8C65B" fill-opacity="0.14"/>
  <path d="M96 174H1184M96 320H1184M96 466H1184" stroke="#FFFFFF" stroke-opacity="0.055" stroke-width="2"/>
  <g filter="url(#shadow)" transform="translate(718 116) rotate(-2)">
    <rect x="0" y="0" width="486" height="334" rx="28" fill="#081118" stroke="#D1FAE5" stroke-opacity="0.2"/>
    <image x="10" y="10" width="466" height="314" preserveAspectRatio="xMidYMid slice" href="${screenshot}"/>
  </g>
  <image x="82" y="102" width="132" height="132" href="${logo}"/>
  <text x="242" y="165" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="66" font-weight="850">Tianshe</text>
  <text x="246" y="218" fill="#A7F3D0" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" letter-spacing="3">LOCAL AI AUTOMATION RUNTIME</text>
  <text x="86" y="330" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="48" font-weight="820">Local-first desktop tools</text>
  <text x="86" y="388" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="48" font-weight="820">for AI agents.</text>
  <text x="88" y="462" fill="#A7B4C2" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="25" font-weight="600">Browser automation · DuckDB datasets · Trusted plugins · MCP</text>
</svg>`;

  await renderSvgToPng(svg, path.join(socialDir, 'github-social-preview.png'), width, height);
}

async function generateArchitecture() {
  const logo = readDataUri(path.join(brandDir, 'tianshe-mark.svg'));
  const width = 1600;
  const height = 980;
  const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
      <path d="M2 2L10 6L2 10" fill="none" stroke="#A7F3D0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect width="${width}" height="${height}" rx="42" fill="#081118"/>
  <circle cx="240" cy="160" r="420" fill="#2DD4BF" fill-opacity="0.1"/>
  <circle cx="1400" cy="860" r="480" fill="#F8C65B" fill-opacity="0.1"/>
  <path d="M110 240H1490M110 490H1490M110 740H1490" stroke="#FFFFFF" stroke-opacity="0.045" stroke-width="2"/>
  <image x="112" y="86" width="72" height="72" href="${logo}"/>
  <text x="204" y="130" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="44" font-weight="850">Tianshe Architecture</text>
  <text x="206" y="172" fill="#A7B4C2" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="22" font-weight="600">A local desktop runtime that exposes real browser, data, plugin, and orchestration capabilities.</text>

  ${architectureNode({ x: 114, y: 270, w: 372, h: 110, title: 'React Renderer', body: 'Datasets, plugins, profiles, settings', accent: '#7DD3FC' })}
  ${architectureNode({ x: 614, y: 270, w: 372, h: 110, title: 'Preload Bridge', body: 'Typed contextBridge API surface', accent: '#2DD4BF' })}
  ${architectureNode({ x: 1114, y: 270, w: 372, h: 110, title: 'Electron Main', body: 'IPC, lifecycle, services, packaging hooks', accent: '#A3E635' })}

  <path d="M500 325H592" stroke="#A7F3D0" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow)"/>
  <path d="M1000 325H1092" stroke="#A7F3D0" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow)"/>

  ${architectureNode({ x: 114, y: 548, w: 300, h: 118, title: 'DuckDB', body: 'Local tables, imports, query templates', accent: '#38BDF8' })}
  ${architectureNode({ x: 464, y: 548, w: 300, h: 118, title: 'Browser Pool', body: 'Profiles, accounts, sessions, views', accent: '#34D399' })}
  ${architectureNode({ x: 814, y: 548, w: 300, h: 118, title: 'Plugin Runtime', body: 'First-party JS plugins and helpers', accent: '#BEF264' })}
  ${architectureNode({ x: 1164, y: 548, w: 300, h: 118, title: 'HTTP / MCP', body: 'Agent and CLI orchestration APIs', accent: '#F8C65B' })}

  <path d="M1300 392V520" stroke="#A7F3D0" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow)"/>
  <path d="M1300 442C1300 500 264 500 264 526" stroke="#A7F3D0" stroke-opacity="0.46" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow)"/>
  <path d="M1300 442C1300 500 614 500 614 526" stroke="#A7F3D0" stroke-opacity="0.46" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow)"/>
  <path d="M1300 442C1300 500 964 500 964 526" stroke="#A7F3D0" stroke-opacity="0.46" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow)"/>

  <g transform="translate(176 782)">
    <rect width="1248" height="92" rx="24" fill="#ECFEFF" fill-opacity="0.06" stroke="#ECFEFF" stroke-opacity="0.1"/>
    <text x="34" y="39" fill="#F8FAFC" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="24" font-weight="800">Open Edition Boundary</text>
    <text x="34" y="68" fill="#A7B4C2" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="18" font-weight="600">Cloud auth, hosted catalogs, private snapshots, and deployment endpoints stay outside this repository.</text>
  </g>
</svg>`;

  await renderSvgToPng(svg, path.join(diagramsDir, 'architecture.png'), width, height);
}

async function main() {
  [heroDir, socialDir, diagramsDir].forEach(ensureDir);
  await generateHero();
  await generateSocial();
  await generateArchitecture();
  console.log('[marketing-assets] generated hero, social preview, and architecture diagram');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
