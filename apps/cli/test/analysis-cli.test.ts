import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { createSandbox } from '../src/sandbox.ts';

test('the synthetic handoff CLI emits standalone Markdown with only the approved background', () => {
  const sandbox = createSandbox();
  try {
    const output = execFileSync(process.execPath, ['apps/cli/src/main.ts', 'handoff', '--sandbox', sandbox.root, '--scenario', 'synthetic'],
      { encoding: 'utf8', timeout: 20000 }).trim().split('\n').map(line => JSON.parse(line));
    const result = output.find(item => item.event === 'handoff-result');
    assert.equal(result.sends, 0);
    assert.match(result.markdown, /背景：测试日志缺少环境字段/);
    assert.match(result.markdown, /非目标：改变运行策略/);
    assert.match(result.markdown, /验收：合成日志包含环境字段/);
    assert.match(result.markdown, /报告版本：1/);
    assert.doesNotMatch(result.markdown, /未交付的其他项目背景/);
    assert.equal(result.export.status, 'durable');
  } finally { rmSync(sandbox.root, { recursive: true, force: true }); }
});
