import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const corePath = /^core\//;
const platformPath = /^(?:adapters\/|bootstrap\/|modules\/(?:host|platform|qqTools)\/)/;
const hostGlobals = new Set(['Bot', 'global', 'globalThis', 'process', 'pluginBridge']);
const relativeSourcePath = (root, path) => relative(resolve(root, 'src'), resolve(root, path)).replaceAll('\\', '/');

export function checkSource(path, text, root = process.cwd(), options = {}) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const errors = [];
  const source = relativeSourcePath(root, path);
  const pure = /^(?:contracts\/|modules\/[^/]+\/(?:domain|application)\/)/.test(source);
  const core = options.core ?? corePath.test(source);
  const add = (node, message) => errors.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${message}`);
  const checkImport = (node, specifier) => {
    const local = specifier.startsWith('.');
    if (local && !specifier.endsWith('.js')) add(node, 'Relative imports must use an explicit .js extension');
    const target = local ? relativeSourcePath(root, resolve(dirname(resolve(root, path)), specifier)) : '';
    const outside = target.startsWith('../');
    if (pure && (!local || outside || /(?:^|\/)(adapters|bootstrap|infrastructure)(?:\/|$)/.test(target) || corePath.test(target))) {
      add(node, 'Domain/application/contracts may only import internal contracts and domain/application modules');
    }
    if (!core) return;
    if (local && (outside || platformPath.test(target))) {
      add(node, 'Agent core cannot depend on platform adapters, bootstraps or legacy host modules');
    } else if (local) {
      options.onCoreDependency?.(target);
    }
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkImport(node, node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) checkImport(node, node.argument.literal.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) checkImport(node, node.arguments[0].text);
      else if (pure || core) add(node, 'Computed dynamic imports are forbidden in domain/application/contracts and the agent core');
    }
    if (ts.isIdentifier(node) && ((pure && node.text === 'redis') || ((pure || core) && hostGlobals.has(node.text)))) {
      const parent = node.parent;
      const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || ((ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent)) && parent.name === node);
      const bindingProperty = ts.isBindingElement(parent) && parent.propertyName === node;
      if (!propertyName && !bindingProperty) add(node, `Platform/global access ${node.text} is forbidden in ${core ? 'the agent core' : 'domain/application/contracts'}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}
export function checkTree(root = process.cwd()) {
  const errors = [];
  const sources = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(path)) sources.set(relativeSourcePath(root, path), readFileSync(path, 'utf8'));
    }
  };
  walk(resolve(root, 'src'));
  const pending = new Set([...sources.keys()].filter(path => corePath.test(path)));
  const checked = new Set();
  for (const source of pending) {
    const text = sources.get(source);
    if (text === undefined) continue;
    checked.add(source);
    errors.push(...checkSource(`src/${source}`, text, root, { core: true, onCoreDependency: target => {
      const typescript = target.replace(/\.js$/, '.ts');
      const declaration = target.replace(/\.js$/, '.d.ts');
      if (sources.has(typescript)) pending.add(typescript);
      else if (sources.has(declaration)) pending.add(declaration);
      else errors.push(`src/${source}: Agent core dependency ${target} must resolve to a TypeScript source`);
    } }));
  }
  for (const [source, text] of sources) {
    if (!checked.has(source)) errors.push(...checkSource(`src/${source}`, text, root));
  }
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkTree();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Backend source boundaries passed');
}
