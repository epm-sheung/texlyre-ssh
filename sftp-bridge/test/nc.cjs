// test/nc.cjs — tiny netcat used as a ProxyCommand in tests: node nc.cjs HOST PORT
const net = require('node:net');

const [host, port] = process.argv.slice(2);
const sock = net.connect(Number(port), host);
process.stdin.pipe(sock);
sock.pipe(process.stdout);
sock.on('close', () => process.exit(0));
sock.on('error', (err) => {
	process.stderr.write(`nc: ${err.message}\n`);
	process.exit(1);
});
