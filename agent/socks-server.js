#!/usr/bin/env node
/**
 * Minimal SOCKS5 server for WireGuard VPN output.
 *
 * DNS resolution uses the container's normal resolver (main routing table).
 * Outgoing TCP connections are bound to WIREGUARD_LOCAL_ADDR (the WireGuard interface IP),
 * so the kernel routes them through the WireGuard interface automatically.
 * No iptables or policy routing required.
 */
import net from 'net';
import dns from 'dns/promises';

const localAddr = process.env.WIREGUARD_LOCAL_ADDR;
const port = parseInt(process.env.WIREGUARD_SOCKS_PORT || '1080', 10);

if (!localAddr) {
  console.error('[socks] WIREGUARD_LOCAL_ADDR not set');
  process.exit(1);
}

const server = net.createServer((client) => {
  client.on('error', () => {});

  client.once('data', (greeting) => {
    if (greeting[0] !== 0x05) { client.end(); return; }
    client.write(Buffer.from([0x05, 0x00]));

    client.once('data', async (req) => {
      if (req[0] !== 0x05 || req[1] !== 0x01) {
        client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.end();
        return;
      }

      let host;
      let dstPort;
      const atype = req[3];

      try {
        if (atype === 0x01) {
          host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
          dstPort = req.readUInt16BE(8);
        } else if (atype === 0x03) {
          const len = req[4];
          host = req.subarray(5, 5 + len).toString();
          dstPort = req.readUInt16BE(5 + len);
        } else if (atype === 0x04) {
          const parts = [];
          for (let i = 4; i < 20; i += 2) parts.push(req.readUInt16BE(i).toString(16));
          host = parts.join(':');
          dstPort = req.readUInt16BE(20);
        } else {
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.end();
          return;
        }

        let connectAddr = host;
        if (atype === 0x03) {
          const result = await dns.lookup(host);
          connectAddr = result.address;
        }

        const remote = net.connect({
          host: connectAddr,
          port: dstPort,
          localAddress: localAddr,
        }, () => {
          const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          client.write(reply);
          client.pipe(remote);
          remote.pipe(client);
        });

        remote.on('error', (err) => {
          console.error(`[socks] connect error to ${host}:${dstPort}: ${err.message}`);
          const reply = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          if (client.writable) client.write(reply);
          client.end();
        });

        client.on('close', () => remote.destroy());
        remote.on('close', () => client.destroy());
      } catch (err) {
        console.error(`[socks] error for ${host}: ${err.message}`);
        const reply = Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        if (client.writable) client.write(reply);
        client.end();
      }
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[socks] SOCKS5 proxy on 127.0.0.1:${port} (outgoing via ${localAddr})`);
});
