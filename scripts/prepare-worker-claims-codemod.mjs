import fs from 'node:fs';

const path = 'scripts/apply-worker-claims-codemod.mjs';
const lines = fs.readFileSync(path, 'utf8').split('\n');
let angleFixed = 0;
let sourceUrlFixed = 0;

const next = lines.map(line => {
  if (line.includes('angle: \\\\`') && line.includes('angle.label') && line.includes('angle.thesis')) {
    angleFixed++;
    return "      angle: angle.label + ': ' + angle.thesis,";
  }
  if (line.includes('sourceUrl: currentAngle.source_url || \\\\`banked-angle:')) {
    sourceUrlFixed++;
    return "        sourceUrl: currentAngle.source_url || 'banked-angle:' + currentAngle.id,";
  }
  return line;
});

if (angleFixed !== 1 || sourceUrlFixed !== 1) {
  throw new Error(`expected one generated-expression fix each; angle=${angleFixed} sourceUrl=${sourceUrlFixed}`);
}

fs.writeFileSync(path, next.join('\n'));
console.log('codemod generated expressions normalized');
