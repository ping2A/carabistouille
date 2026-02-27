/**
 * Config tests: shape, types, and default behaviour.
 * Uses dynamic import so we can set process.env before loading config.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('config', () => {
  it('has server with url and rejectUnauthorized', async () => {
    const { default: config } = await import('../config.js');
    assert.ok(config.server);
    assert.strictEqual(typeof config.server.url, 'string');
    assert.ok(config.server.url.endsWith('/ws/agent'));
    assert.strictEqual(typeof config.server.rejectUnauthorized, 'boolean');
  });

  it('has browser with headless, engine, viewport, and args', async () => {
    const { default: config } = await import('../config.js');
    assert.ok(config.browser);
    assert.ok(config.browser.headless === false || config.browser.headless === 'new' || config.browser.headless === 'shell');
    assert.strictEqual(typeof config.browser.engine, 'string');
    assert.ok(['puppeteer', 'puppeteer-extra'].includes(config.browser.engine));
    assert.strictEqual(typeof config.browser.viewportWidth, 'number');
    assert.strictEqual(typeof config.browser.viewportHeight, 'number');
    assert.ok(Array.isArray(config.browser.args));
    assert.ok(config.browser.args.length > 0);
    assert.ok(config.browser.args.includes('--no-sandbox'));
    assert.strictEqual(config.browser.ignoreHTTPSErrors, true);
    assert.strictEqual(config.browser.bypassCSP, true);
  });

  it('has navigation with timeout and waitUntilChain', async () => {
    const { default: config } = await import('../config.js');
    assert.ok(config.navigation);
    assert.strictEqual(typeof config.navigation.timeout, 'number');
    assert.ok(config.navigation.timeout >= 1000);
    assert.ok(Array.isArray(config.navigation.waitUntilChain));
    assert.ok(config.navigation.waitUntilChain.length > 0);
  });

  it('has screenshots with format, quality, intervalMs', async () => {
    const { default: config } = await import('../config.js');
    assert.ok(config.screenshots);
    assert.strictEqual(typeof config.screenshots.format, 'string');
    assert.strictEqual(typeof config.screenshots.quality, 'number');
    assert.strictEqual(typeof config.screenshots.intervalMs, 'number');
  });
});
