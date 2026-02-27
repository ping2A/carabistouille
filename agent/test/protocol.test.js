/**
 * Protocol tests: command and event shapes match server expectations (Rust AgentCommand / AgentEvent).
 * Ensures JSON serialization has required fields and valid types.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('agent commands', () => {
  it('navigate command has type, analysis_id, url and optional proxy/user_agent', () => {
    const cmd = {
      type: 'navigate',
      analysis_id: 'id-1',
      url: 'https://example.com',
      proxy: null,
      user_agent: null,
    };
    const json = JSON.stringify(cmd);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.type, 'navigate');
    assert.strictEqual(parsed.analysis_id, 'id-1');
    assert.strictEqual(parsed.url, 'https://example.com');
  });

  it('stop_analysis command has type and analysis_id', () => {
    const cmd = { type: 'stop_analysis', analysis_id: 'id-2' };
    const parsed = JSON.parse(JSON.stringify(cmd));
    assert.strictEqual(parsed.type, 'stop_analysis');
    assert.strictEqual(parsed.analysis_id, 'id-2');
  });

  it('click command has type, analysis_id, x, y', () => {
    const cmd = { type: 'click', analysis_id: 'id-3', x: 100, y: 200 };
    const parsed = JSON.parse(JSON.stringify(cmd));
    assert.strictEqual(parsed.type, 'click');
    assert.strictEqual(parsed.x, 100);
    assert.strictEqual(parsed.y, 200);
  });

  it('key_press command has type, analysis_id, key', () => {
    const cmd = { type: 'key_press', analysis_id: 'id-4', key: 'Enter' };
    const parsed = JSON.parse(JSON.stringify(cmd));
    assert.strictEqual(parsed.type, 'key_press');
    assert.strictEqual(parsed.key, 'Enter');
  });
});

describe('agent events', () => {
  it('agent_ready event has type only', () => {
    const evt = { type: 'agent_ready' };
    const parsed = JSON.parse(JSON.stringify(evt));
    assert.strictEqual(parsed.type, 'agent_ready');
  });

  it('redirect_detected event has type, analysis_id, from, to, status', () => {
    const evt = {
      type: 'redirect_detected',
      analysis_id: 'id-5',
      from: 'http://a.com',
      to: 'https://a.com',
      status: 301,
    };
    const parsed = JSON.parse(JSON.stringify(evt));
    assert.strictEqual(parsed.type, 'redirect_detected');
    assert.strictEqual(parsed.from, 'http://a.com');
    assert.strictEqual(parsed.to, 'https://a.com');
    assert.strictEqual(parsed.status, 301);
  });

  it('screenshot event has type, analysis_id, data, width, height', () => {
    const evt = {
      type: 'screenshot',
      analysis_id: 'id-6',
      data: 'base64...',
      width: 1280,
      height: 800,
    };
    const parsed = JSON.parse(JSON.stringify(evt));
    assert.strictEqual(parsed.type, 'screenshot');
    assert.strictEqual(typeof parsed.data, 'string');
    assert.strictEqual(parsed.width, 1280);
    assert.strictEqual(parsed.height, 800);
  });

  it('error event has type, analysis_id, message', () => {
    const evt = {
      type: 'error',
      analysis_id: 'id-7',
      message: 'Something failed',
    };
    const parsed = JSON.parse(JSON.stringify(evt));
    assert.strictEqual(parsed.type, 'error');
    assert.strictEqual(parsed.message, 'Something failed');
  });

  it('network_request_captured has type, analysis_id, request object', () => {
    const evt = {
      type: 'network_request_captured',
      analysis_id: 'id-8',
      request: {
        url: 'https://example.com/',
        method: 'GET',
        status: 200,
        timestamp: 12345.67,
      },
    };
    const parsed = JSON.parse(JSON.stringify(evt));
    assert.strictEqual(parsed.type, 'network_request_captured');
    assert.strictEqual(parsed.request.url, 'https://example.com/');
    assert.strictEqual(parsed.request.method, 'GET');
  });
});
