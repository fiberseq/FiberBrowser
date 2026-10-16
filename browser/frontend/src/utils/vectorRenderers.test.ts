import { describe, it, expect } from 'vitest';
import { SvgRenderer } from './vectorRenderers';

describe('SvgRenderer', () => {
  it('emits a top-level <svg> with width/height/viewBox', () => {
    const r = new SvgRenderer(100, 50);
    const svg = r.toSvg();
    expect(svg).toContain('<svg');
    expect(svg).toContain('width="100"');
    expect(svg).toContain('height="50"');
    expect(svg).toContain('viewBox="0 0 100 50"');
  });

  it('does NOT emit <defs>, <clipPath>, or <g> wrappers', () => {
    // These were the canvas2svg constructs that crashed Illustrator.
    const r = new SvgRenderer(50, 50);
    r.fillStyle = '#ff0000';
    r.fillRect(0, 0, 10, 10);
    r.fillStyle = '#00ff00';
    r.fillRect(20, 20, 10, 10);
    const svg = r.toSvg();
    expect(svg).not.toContain('<defs');
    expect(svg).not.toContain('<clipPath');
    expect(svg).not.toContain('<g ');
    expect(svg).not.toContain('<g>');
  });

  it('emits each fillRect as a separate <path> with the current fill color', () => {
    const r = new SvgRenderer(100, 100);
    r.fillStyle = '#aabbcc';
    r.fillRect(10, 20, 30, 40);
    const svg = r.toSvg();
    expect(svg).toMatch(/<path d="M 10 20 L 40 20 L 40 60 L 10 60 Z" fill="#aabbcc"\s*\/>/);
  });

  it('bakes the active translate/rotate into path coordinates', () => {
    const r = new SvgRenderer(100, 100);
    r.translate(10, 10);
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.strokeStyle = '#000000';
    r.stroke();
    const svg = r.toSvg();
    // The line should appear at screen coords (10,10)-(20,10), not (0,0)-(10,0).
    expect(svg).toContain('M 10 10 L 20 10');
  });

  it('emits stroked paths with stroke + stroke-width attributes (no fill)', () => {
    const r = new SvgRenderer(50, 50);
    r.strokeStyle = '#123456';
    r.lineWidth = 2;
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 10);
    r.stroke();
    const svg = r.toSvg();
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('fill="none"');
  });

  it('emits text as <text> with x/y in screen coordinates and a font-size', () => {
    const r = new SvgRenderer(100, 100);
    r.font = 'bold 12px Arial';
    r.fillStyle = '#222222';
    r.fillText('hello', 30, 40);
    const svg = r.toSvg();
    expect(svg).toMatch(/<text x="30"/);
    expect(svg).toContain('font-family="Arial"');
    expect(svg).toContain('font-size="12"');
    expect(svg).toContain('font-weight="bold"');
    expect(svg).toContain('>hello<');
  });

  it('rotates text via SVG rotate transform around its anchor', () => {
    const r = new SvgRenderer(200, 200);
    r.translate(100, 100);
    r.rotate(-Math.PI / 2);
    r.fillText('vertical', 0, 0);
    const svg = r.toSvg();
    expect(svg).toMatch(/transform="rotate\(-90 100 100\)"/);
  });

  it('escapes XML-special characters in text', () => {
    const r = new SvgRenderer(100, 100);
    r.fillText('a < b & c > d', 0, 0);
    const svg = r.toSvg();
    expect(svg).toContain('a &lt; b &amp; c &gt; d');
  });

  it('honors save()/restore() for both styles and transforms', () => {
    const r = new SvgRenderer(100, 100);
    r.fillStyle = '#111111';
    r.translate(10, 10);
    r.save();
    r.fillStyle = '#222222';
    r.translate(20, 20);
    r.fillRect(0, 0, 5, 5); // expect at screen (30, 30) with #222222
    r.restore();
    r.fillRect(0, 0, 5, 5); // expect at screen (10, 10) with #111111
    const svg = r.toSvg();
    expect(svg).toContain('M 30 30');
    expect(svg).toContain('fill="#222222"');
    expect(svg).toContain('M 10 10');
    expect(svg).toContain('fill="#111111"');
  });

  it('emits dashed strokes with stroke-dasharray', () => {
    const r = new SvgRenderer(50, 50);
    r.setLineDash([3, 3]);
    r.strokeStyle = '#000000';
    r.beginPath();
    r.moveTo(0, 0);
    r.lineTo(10, 0);
    r.stroke();
    const svg = r.toSvg();
    expect(svg).toContain('stroke-dasharray="3 3"');
  });

  it('emits arcs as SVG path A commands so each donut wedge stays a single shape', () => {
    const r = new SvgRenderer(200, 200);
    r.beginPath();
    r.moveTo(100, 100);
    r.arc(100, 100, 50, 0, Math.PI / 2);
    r.lineTo(100, 100);
    r.closePath();
    r.fillStyle = '#abcdef';
    r.fill();
    const svg = r.toSvg();
    expect(svg).toMatch(/<path d="[^"]*A 50 50/);
    expect(svg).toContain('fill="#abcdef"');
  });
});

describe('toPdfText', () => {
  it('keeps Latin-1, maps common symbols, drops icons', async () => {
    const { toPdfText } = await import('./vectorRenderers');
    expect(toPdfText('47,515,000 − 1 kb…')).toBe('47,515,000 - 1 kb...');
    expect(toPdfText('🔒')).toBe('');
    expect(toPdfText('5′ ±2 µm')).toBe('5 ±2 µm');
  });
});
