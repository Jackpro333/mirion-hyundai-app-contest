'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const order = ['thermal', 'comfort', 'mpc', 'gate', 'verify', 'blackice', 'scenario', 'runtime'];
let bundle = 'const __defs = {};\nconst __cache = {};\nfunction __req(name) {\n  const key = name.replace("./", "");\n  if (!__cache[key]) {\n    const module = { exports: {} };\n    __defs[key](module, module.exports, __req);\n    __cache[key] = module.exports;\n  }\n  return __cache[key];\n}\n';
for (const name of order) {
  const src = fs.readFileSync(path.join(root, 'src', `${name}.js`), 'utf8').replace(/<\/script/g, '<\\/script');
  bundle += `__defs[${JSON.stringify(name)}] = function (module, exports, require) {\n${src}\n};\n`;
}
const results = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'results.json'), 'utf8'));
const template = fs.readFileSync(path.join(root, 'demo', 'template.html'), 'utf8');
if (!template.includes('__ENGINE__;')) throw new Error('template.html 에 __ENGINE__; 자리가 없습니다.');
const html = template.replace('__ENGINE__;', () => bundle).replace('__GATE_FULL__', results.gate.checked.toLocaleString('en-US'));
fs.writeFileSync(path.join(root, 'demo', 'index.html'), html);
const carTemplate = fs.readFileSync(path.join(root, 'android', 'car.template.html'), 'utf8');
const carOut = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'car.html');
fs.mkdirSync(path.dirname(carOut), { recursive: true });
fs.writeFileSync(carOut, carTemplate.replace('__ENGINE__;', () => bundle));
console.log('demo/index.html', (fs.statSync(path.join(root, 'demo', 'index.html')).size / 1024).toFixed(0) + ' KB');
