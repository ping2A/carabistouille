import WebSocket from 'ws';
import { BrowserManager } from './browser.js';
import { Analyzer } from './analyzer.js';
import config from '../config.js';

const SERVER_URL = config.server.url;

class Agent {
  constructor() {
    this.ws = null;
    this.browserManager = new BrowserManager();
    this.analyzer = new Analyzer(this.browserManager);
    this.reconnectDelay = 1000;
    this.sendCount = 0;
  }

  connect() {
    console.log(`[agent] Connecting to server at ${SERVER_URL}...`);
    const wsOptions = {};
    if (SERVER_URL.startsWith('wss://')) {
      wsOptions.rejectUnauthorized = config.server.rejectUnauthorized;
    }
    this.ws = new WebSocket(SERVER_URL, wsOptions);

    this.ws.on('open', () => {
      console.log('[agent] Connected to server');
      this.reconnectDelay = 1000;
      this.send({ type: 'agent_ready' });
      console.log('[agent] Sent agent_ready');
    });

    this.ws.on('message', async (data) => {
      try {
        const command = JSON.parse(data.toString());
        await this.handleCommand(command);
      } catch (err) {
        console.error('[agent] Error handling command:', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[agent] Disconnected (code=${code} reason=${reason}), reconnecting in ${this.reconnectDelay}ms...`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    });

    this.ws.on('error', (err) => {
      console.error('[agent] WebSocket error:', err.message);
    });
  }

  send(event) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(event);
      this.ws.send(json);
      this.sendCount++;
      if (event.type === 'screenshot') {
        console.log(`[agent] -> screenshot for ${event.analysis_id} (${(json.length / 1024).toFixed(1)} KB, total sends: ${this.sendCount})`);
      } else if (event.type !== 'agent_ready') {
        console.log(`[agent] -> ${event.type} for ${event.analysis_id} (${json.length} bytes)`);
      }
    } else {
      console.warn(`[agent] Cannot send ${event.type}: WebSocket not open (state=${this.ws?.readyState})`);
    }
  }

  async handleCommand(command) {
    const type = command.type;
    const aid = command.analysis_id;
    if (type !== 'move_mouse') {
      console.log(`[agent] <- ${type} [${aid || ''}]`);
    }

    try {
      switch (type) {
        case 'navigate':
          await this.browserManager.createSession(aid, command.proxy || null);
          await this.analyzer.startAnalysis(aid, command.url, (evt) => this.send(evt));
          console.log(`[agent] Analysis ${aid} is live, waiting for stop command`);
          break;

        case 'click':
          await this.browserManager.click(aid, command.x, command.y);
          await this.analyzer.reportClipboard(aid, 'click');
          await this.sendScreenshot(aid);
          break;

        case 'scroll':
          await this.browserManager.scroll(aid, command.delta_x, command.delta_y);
          await this.sendScreenshot(aid);
          break;

        case 'move_mouse':
          await this.browserManager.moveMouse(aid, command.x, command.y);
          break;

        case 'type_text':
          await this.browserManager.typeText(aid, command.text);
          await this.sendScreenshot(aid);
          break;

        case 'key_press':
          await this.browserManager.keyPress(aid, command.key);
          await this.analyzer.reportClipboard(aid, 'keypress');
          await this.sendScreenshot(aid);
          break;

        case 'inspect_element': {
          const info = await this.browserManager.inspectElement(aid, command.x, command.y);
          if (info) {
            this.send({ type: 'element_info', analysis_id: aid, ...info });
          } else {
            console.warn(`[agent] No element found at (${command.x}, ${command.y})`);
          }
          break;
        }

        case 'stop_analysis':
          await this.analyzer.stopAnalysis(aid);
          break;

        default:
          console.warn(`[agent] Unknown command type: ${type}`);
      }
    } catch (err) {
      console.error(`[agent] Error handling ${type}:`, err.message, err.stack);
      if (aid) {
        this.send({ type: 'error', analysis_id: aid, message: err.message });
      }
    }
  }

  async sendScreenshot(analysisId) {
    const screenshot = await this.browserManager.takeScreenshot(analysisId);
    if (screenshot) {
      this.send({
        type: 'screenshot',
        analysis_id: analysisId,
        data: screenshot.data,
        width: screenshot.width,
        height: screenshot.height,
      });
    } else {
      console.warn(`[agent] Failed to take screenshot for ${analysisId}`);
    }
  }
}

const agent = new Agent();
agent.connect();

process.on('SIGINT', async () => {
  console.log('[agent] Shutting down...');
  await agent.browserManager.closeAll();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent] Unhandled rejection:', reason);
});
