import PDFDocument from 'pdfkit';
import { writeFileSync } from 'fs';
const doc = new PDFDocument({ margin: 40, size: 'A4' });
const chunks = [];
doc.on('data', c => chunks.push(c));
doc.on('end', () => writeFileSync('/tmp/probe.pdf', Buffer.concat(chunks)));

const W = 595.28 - 80, PH = 841.89;

// Text at from-top 100
doc.font('Helvetica').fontSize(14).fillColor('#000000').text('TEXT at y=100 (from top)', 40, 100);

// Rect with rect(x, 100, w, 20) — literal 100 from bottom? or top?
doc.rect(40, 100, 200, 20).fill('#ff0000');  // red box at y=100 raw

// Green box via my conversion PH - y - h
doc.rect(40, PH - 100 - 20, 200, 20).fill('#00ff00');

doc.end();
