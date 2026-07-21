#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOOK_PATH = path.join(__dirname, 'runtime-activity-hook.js');
const MANAGED_MARKER = '--tmux-dashboard-runtime-activity-v1';

export const CLAUDE_HOOK_SPECS = [
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
  { event: 'PostToolUse', matcher: 'AskUserQuestion' },
  { event: 'PostToolUseFailure', matcher: 'AskUserQuestion' },
  { event: 'PermissionRequest' },
  { event: 'Notification', matcher: 'permission_prompt|idle_prompt|agent_needs_input' },
  { event: 'Stop' },
  { event: 'StopFailure' },
];

export const CODEX_HOOK_SPECS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '^request_user_input$' },
  { event: 'PostToolUse', matcher: '^request_user_input$' },
  { event: 'PermissionRequest' },
  { event: 'Stop' },
];

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function posixQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function hookCommand(agent, hookPath = DEFAULT_HOOK_PATH, nodePath = process.execPath) {
  return `${posixQuote(nodePath)} ${posixQuote(path.resolve(hookPath))} --agent ${agent} ${MANAGED_MARKER}`;
}

function validateHookGroups(groups, event) {
  if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
  for (const group of groups) {
    if (!isObject(group)) throw new Error(`hooks.${event} contains a non-object matcher group`);
    if (!Array.isArray(group.hooks)) throw new Error(`hooks.${event} matcher group must contain a hooks array`);
  }
}

function sameMatcher(group, matcher) {
  if (matcher === undefined) return !Object.hasOwn(group, 'matcher');
  return group.matcher === matcher;
}

export function mergeHookSpecs(existing, specs, command, { description } = {}) {
  if (!isObject(existing)) throw new Error('configuration root must be a JSON object');
  const next = JSON.parse(JSON.stringify(existing));
  if (next.hooks === undefined) next.hooks = {};
  if (!isObject(next.hooks)) throw new Error('hooks must be a JSON object');
  if (description && next.description === undefined) next.description = description;

  let added = 0;
  let updated = 0;
  const changedSpecs = [];
  for (const spec of specs) {
    if (next.hooks[spec.event] === undefined) next.hooks[spec.event] = [];
    const groups = next.hooks[spec.event];
    validateHookGroups(groups, spec.event);

    const candidates = groups.filter((group) => sameMatcher(group, spec.matcher));
    const alreadyPresent = candidates.some((group) => group.hooks.some(
      (handler) => isObject(handler) && handler.type === 'command' && handler.command === command,
    ));
    if (alreadyPresent) continue;

    const managedHandler = candidates
      .flatMap((group) => group.hooks)
      .find((handler) => (
        isObject(handler)
        && handler.type === 'command'
        && typeof handler.command === 'string'
        && handler.command.includes(MANAGED_MARKER)
      ));
    if (managedHandler) {
      managedHandler.command = command;
      managedHandler.timeout = 3;
      updated += 1;
      changedSpecs.push({ ...spec });
      continue;
    }

    let target = candidates[0];
    if (!target) {
      target = spec.matcher === undefined
        ? { hooks: [] }
        : { matcher: spec.matcher, hooks: [] };
      groups.push(target);
    }
    target.hooks.push({ type: 'command', command, timeout: 3 });
    added += 1;
    changedSpecs.push({ ...spec });
  }
  return { config: next, added, updated, changedSpecs };
}

function parseJsonFile(file) {
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!stat) {
    return { exists: false, config: {}, indent: 2, mode: 0o600, original: '' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`refusing non-regular configuration path: ${file}`);
  }
  const original = fs.readFileSync(file, 'utf8');
  const text = original.replace(/^\uFEFF/, '');
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`);
  }
  if (!isObject(config)) throw new Error(`configuration root must be an object: ${file}`);
  const indentMatch = text.match(/\n( +)"/);
  return {
    exists: true,
    config,
    indent: indentMatch ? Math.min(8, indentMatch[1].length) : 2,
    mode: stat.mode & 0o777,
    original,
  };
}

export function buildInstallPlan({ provider, file, command }) {
  const source = parseJsonFile(file);
  const specs = provider === 'claude' ? CLAUDE_HOOK_SPECS : CODEX_HOOK_SPECS;
  const description = provider === 'codex'
    ? 'Tmux Dashboard runtime activity hooks.'
    : undefined;
  const merged = mergeHookSpecs(source.config, specs, command, { description });
  return {
    provider,
    file,
    ...source,
    added: merged.added,
    updated: merged.updated,
    changedSpecs: merged.changedSpecs,
    changed: merged.added + merged.updated > 0,
    content: `${JSON.stringify(merged.config, null, source.indent)}\n`,
  };
}

function inspectSafeDirectory(dir) {
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`refusing non-directory configuration parent: ${dir}`);
  }
  return true;
}

function ensureSafeDirectory(dir) {
  if (!inspectSafeDirectory(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function backupName(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const base = `${file}.bak-${stamp}`;
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`unable to allocate backup name for ${file}`);
}

function atomicWrite(file, content, mode) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

export function applyInstallPlans(plans, now = new Date()) {
  const changed = plans.filter((plan) => plan.changed);
  const backups = new Map();
  for (const plan of changed) ensureSafeDirectory(path.dirname(plan.file));
  for (const plan of changed) {
    if (!plan.exists) continue;
    const backup = backupName(plan.file, now);
    fs.copyFileSync(plan.file, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, plan.mode);
    backups.set(plan.file, backup);
  }

  const applied = [];
  try {
    for (const plan of changed) {
      atomicWrite(plan.file, plan.content, plan.mode);
      applied.push(plan);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of applied.reverse()) {
      try {
        if (plan.exists) atomicWrite(plan.file, plan.original, plan.mode);
        else fs.unlinkSync(plan.file);
      } catch (rollbackError) {
        rollbackErrors.push(`${plan.file}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      error.message += `; rollback failed for ${rollbackErrors.join(', ')}`;
    }
    throw error;
  }
  return backups;
}

export function parseInstallerArgs(argv) {
  const options = {
    apply: false,
    check: false,
    providers: new Set(),
    home: os.homedir(),
    hookPath: DEFAULT_HOOK_PATH,
  };
  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--check' || arg === '--dry-run') options.check = true;
    else if (arg === '--claude') options.providers.add('claude');
    else if (arg === '--codex') options.providers.add('codex');
    else if (arg === '--home') options.home = path.resolve(takeValue(arg, i++));
    else if (arg === '--hook-path') options.hookPath = path.resolve(takeValue(arg, i++));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.apply && options.check) throw new Error('choose either --apply or --check');
  return options;
}

function usage() {
  return [
    'Usage: node server/scripts/install-runtime-activity-hooks.js [options]',
    '',
    'Default mode is read-only check/dry-run. No configuration is written.',
    '  --apply       Back up and atomically merge selected configurations',
    '  --check       Explicit read-only mode (same as default)',
    '  --claude      Select ~/.claude/settings.json',
    '  --codex       Select ~/.codex/hooks.json',
    '  --home PATH   Override the home directory (useful for staging/tests)',
    '  --hook-path PATH  Override the runtime hook path',
    '',
    'Without --claude/--codex, existing ~/.claude and ~/.codex directories are detected.',
    'Examples:',
    '  node server/scripts/install-runtime-activity-hooks.js',
    '  node server/scripts/install-runtime-activity-hooks.js --apply --claude --codex',
  ].join('\n');
}

function selectedProviders(options) {
  if (options.providers.size) return [...options.providers];
  const detected = [];
  if (fs.existsSync(path.join(options.home, '.claude'))) detected.push('claude');
  if (fs.existsSync(path.join(options.home, '.codex'))) detected.push('codex');
  if (!detected.length) {
    throw new Error('no Claude or Codex config directory detected; select --claude and/or --codex');
  }
  return detected;
}

function validateHookFile(hookPath) {
  const stat = fs.lstatSync(hookPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`runtime hook must be a regular file: ${hookPath}`);
  }
}

export function runInstaller(argv = process.argv.slice(2), write = console.log) {
  const options = parseInstallerArgs(argv);
  if (options.help) {
    write(usage());
    return { plans: [], backups: new Map(), applied: false };
  }
  validateHookFile(options.hookPath);
  const providers = selectedProviders(options);
  const plans = providers.map((provider) => {
    const file = provider === 'claude'
      ? path.join(options.home, '.claude', 'settings.json')
      : path.join(options.home, '.codex', 'hooks.json');
    inspectSafeDirectory(path.dirname(file));
    return buildInstallPlan({
      provider,
      file,
      command: hookCommand(provider, options.hookPath),
    });
  });

  let backups = new Map();
  if (options.apply) backups = applyInstallPlans(plans);
  write(options.apply ? 'Mode: apply' : 'Mode: check (no files written)');
  for (const plan of plans) {
    const changes = [];
    if (plan.added) changes.push(`${options.apply ? 'added' : 'would add'} ${plan.added}`);
    if (plan.updated) changes.push(`${options.apply ? 'updated' : 'would update'} ${plan.updated}`);
    const action = changes.length ? `${changes.join(', ')} hook handler(s)` : 'already configured';
    write(`${plan.provider}: ${action}: ${plan.file}`);
    if (plan.changedSpecs.length) {
      const events = plan.changedSpecs.map((spec) => (
        spec.matcher ? `${spec.event}[${spec.matcher}]` : spec.event
      ));
      write(`${plan.provider}: events: ${events.join(', ')}`);
    }
    const backup = backups.get(plan.file);
    if (backup) write(`${plan.provider}: backup: ${backup}`);
  }
  if (!options.apply && plans.some((plan) => plan.changed)) {
    write('Re-run with --apply after reviewing this plan.');
  }
  if (providers.includes('codex')) {
    write('Codex: review and trust the installed command hook with /hooks before relying on it.');
  }
  return { plans, backups, applied: options.apply };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    runInstaller();
  } catch (error) {
    console.error(`runtime activity hook installer: ${error.message}`);
    process.exitCode = 1;
  }
}
