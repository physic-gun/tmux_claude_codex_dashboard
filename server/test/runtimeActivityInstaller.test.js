import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_HOOK_SPECS,
  CODEX_HOOK_SPECS,
  hookCommand,
  mergeHookSpecs,
} from '../scripts/install-runtime-activity-hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.resolve(__dirname, '../scripts/install-runtime-activity-hooks.js');
const runtimeHookPath = path.resolve(__dirname, '../scripts/runtime-activity-hook.js');

test('merging preserves existing Claude hooks and is idempotent', () => {
  const existing = {
    theme: 'dark',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'existing-stop' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'existing-bash' }] }],
    },
  };
  const command = hookCommand('claude', '/srv/runtime hook.js', '/usr/bin/node');
  const first = mergeHookSpecs(existing, CLAUDE_HOOK_SPECS, command);
  assert.equal(first.added, CLAUDE_HOOK_SPECS.length);
  assert.equal(first.config.theme, 'dark');
  assert.equal(first.config.hooks.Stop[0].hooks[0].command, 'existing-stop');
  assert.equal(first.config.hooks.PreToolUse[0].hooks[0].command, 'existing-bash');
  assert.equal(first.config.hooks.PreToolUse.some((group) => group.matcher === 'AskUserQuestion'), true);
  assert.equal(
    first.config.hooks.Notification.some(
      (group) => group.matcher === 'permission_prompt|idle_prompt|agent_needs_input',
    ),
    true,
  );

  const second = mergeHookSpecs(first.config, CLAUDE_HOOK_SPECS, command);
  assert.equal(second.added, 0);
  assert.deepEqual(second.config, first.config);
});

test('Codex generated hooks use the exact request_user_input matcher', () => {
  const command = hookCommand('codex', '/srv/runtime.js', '/usr/bin/node');
  const merged = mergeHookSpecs({}, CODEX_HOOK_SPECS, command, { description: 'activity' });
  assert.equal(merged.config.description, 'activity');
  assert.equal(merged.config.hooks.PreToolUse[0].matcher, '^request_user_input$');
  assert.equal(merged.config.hooks.PostToolUse[0].matcher, '^request_user_input$');
  assert.equal(Object.hasOwn(merged.config.hooks, 'SessionEnd'), false);
  assert.equal(Object.hasOwn(merged.config.hooks, 'StopFailure'), false);
});

test('path migration updates only installer-managed handlers instead of duplicating them', () => {
  const oldCommand = hookCommand('codex', '/old/runtime.js', '/old/node');
  const installed = mergeHookSpecs({}, CODEX_HOOK_SPECS, oldCommand).config;
  installed.hooks.Stop[0].hooks.unshift({ type: 'command', command: 'keep-user-hook' });

  const nextCommand = hookCommand('codex', '/new/runtime.js', '/new/node');
  const migrated = mergeHookSpecs(installed, CODEX_HOOK_SPECS, nextCommand);
  assert.equal(migrated.added, 0);
  assert.equal(migrated.updated, CODEX_HOOK_SPECS.length);
  for (const spec of CODEX_HOOK_SPECS) {
    const group = migrated.config.hooks[spec.event].find((candidate) => (
      spec.matcher === undefined
        ? !Object.hasOwn(candidate, 'matcher')
        : candidate.matcher === spec.matcher
    ));
    const managed = group.hooks.filter((handler) => (
      handler.command?.includes('--tmux-dashboard-runtime-activity-v1')
    ));
    assert.equal(managed.length, 1);
    assert.equal(managed[0].command, nextCommand);
  }
  assert.equal(migrated.config.hooks.Stop[0].hooks[0].command, 'keep-user-hook');
});

test('generated POSIX command safely executes hook paths containing spaces and apostrophes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxdash hook quote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copiedHook = path.join(dir, "runtime hook's copy.mjs");
  fs.copyFileSync(runtimeHookPath, copiedHook);
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const result = spawnSync('/bin/sh', ['-c', hookCommand('claude', copiedHook)], {
    env,
    input: JSON.stringify({ hook_event_name: 'Stop', prompt_id: 'quoted-path' }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('merging rejects malformed hook structures rather than replacing them', () => {
  assert.throws(
    () => mergeHookSpecs({ hooks: [] }, CLAUDE_HOOK_SPECS, 'command'),
    /hooks must be a JSON object/,
  );
  assert.throws(
    () => mergeHookSpecs({ hooks: { Stop: { hooks: [] } } }, CLAUDE_HOOK_SPECS, 'command'),
    /hooks\.Stop must be an array/,
  );
});

test('installer path arguments fail closed when their value is missing', () => {
  const result = spawnSync(process.execPath, [installerPath, '--home', '--apply'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--home requires a path/);
});

test('installer defaults to check mode and writes nothing', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxdash-hook-check-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));

  const result = spawnSync(process.execPath, [installerPath, '--home', home], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mode: check \(no files written\)/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.codex', 'hooks.json')), false);
});

test('installer apply backs up and merges both configs without replacing hooks', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxdash-hook-apply-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(claudeDir);
  fs.mkdirSync(codexDir);
  const claudeFile = path.join(claudeDir, 'settings.json');
  const codexFile = path.join(codexDir, 'hooks.json');
  fs.writeFileSync(claudeFile, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-claude' }] }] },
  }, null, 2));
  fs.writeFileSync(codexFile, JSON.stringify({
    description: 'keep-description',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-codex' }] }] },
  }, null, 2));

  const result = spawnSync(process.execPath, [
    installerPath, '--home', home, '--apply', '--claude', '--codex',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mode: apply/);

  const claude = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  const codex = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
  assert.equal(claude.hooks.Stop[0].hooks[0].command, 'keep-claude');
  assert.equal(codex.hooks.Stop[0].hooks[0].command, 'keep-codex');
  assert.equal(codex.description, 'keep-description');
  assert.equal(claude.hooks.PreToolUse.some((group) => group.matcher === 'AskUserQuestion'), true);
  assert.equal(codex.hooks.PreToolUse.some((group) => group.matcher === '^request_user_input$'), true);

  const claudeBackups = fs.readdirSync(claudeDir).filter((name) => name.startsWith('settings.json.bak-'));
  const codexBackups = fs.readdirSync(codexDir).filter((name) => name.startsWith('hooks.json.bak-'));
  assert.equal(claudeBackups.length, 1);
  assert.equal(codexBackups.length, 1);
  const originalClaude = JSON.parse(fs.readFileSync(path.join(claudeDir, claudeBackups[0]), 'utf8'));
  assert.equal(originalClaude.hooks.Stop[0].hooks[0].command, 'keep-claude');

  const second = spawnSync(process.execPath, [
    installerPath, '--home', home, '--apply', '--claude', '--codex',
  ], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already configured/);
  assert.equal(fs.readdirSync(claudeDir).filter((name) => name.startsWith('settings.json.bak-')).length, 1);
  assert.equal(fs.readdirSync(codexDir).filter((name) => name.startsWith('hooks.json.bak-')).length, 1);
});

test('installer rejects a symlink config without touching its target', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxdash-hook-link-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir);
  const target = path.join(home, 'real-settings.json');
  fs.writeFileSync(target, '{}\n');
  fs.symlinkSync(target, path.join(claudeDir, 'settings.json'));

  const result = spawnSync(process.execPath, [
    installerPath, '--home', home, '--apply', '--claude',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing non-regular configuration path/);
  assert.equal(fs.readFileSync(target, 'utf8'), '{}\n');
});

test('installer validates every selected config before writing either one', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxdash-hook-invalid-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(claudeDir);
  fs.mkdirSync(codexDir);
  const claudeFile = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(claudeFile, '{"theme":"keep"}\n');
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), '{invalid');

  const result = spawnSync(process.execPath, [
    installerPath, '--home', home, '--apply', '--claude', '--codex',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid JSON/);
  assert.equal(fs.readFileSync(claudeFile, 'utf8'), '{"theme":"keep"}\n');
  assert.equal(fs.readdirSync(claudeDir).some((name) => name.includes('.bak-')), false);
});
