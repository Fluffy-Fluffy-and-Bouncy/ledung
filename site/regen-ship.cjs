// Regenerates site/assets/shipFrames.js from the app's web/src/components/shipFrames.ts, so the site's
// ship is always the app's own. Run from the repository root: node site/regen-ship.cjs
const { stripTypeScriptTypes } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let js = stripTypeScriptTypes(fs.readFileSync(path.join(root, 'web', 'src', 'components', 'shipFrames.ts'), 'utf8'), { mode: 'strip' });
const names = [...js.matchAll(/export (?:const|function) (\w+)/g)].map((m) => m[1]);
js = js.replace(/export (const|function)/g, '$1').replace(/^export type .*$/gm, '');
const header = '// Generated from web/src/components/shipFrames.ts with its types stripped; do not edit by hand. To regenerate, see site/README.md.\n';
fs.writeFileSync(path.join(__dirname, 'assets', 'shipFrames.js'), `${header}(function(){\n${js}\nwindow.ShipFrames={${names.join(',')}};\n})();\n`);
