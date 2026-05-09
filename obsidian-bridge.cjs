const http = require("http");
const net = require("net");
const { join } = require("path");
const { homedir } = require("os");

const SOCK = join(homedir(), ".obsidian-cli.sock");
const PORT = 57843;

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sock = net.createConnection(SOCK, () => sock.write(body + "\n"));
      let response = "";
      sock.on("data", (d) => (response += d));
      sock.on("end", () => res.end(response));
      sock.on("error", (e) => {
        res.writeHead(502);
        res.end(e.message);
      });
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`obsidian-bridge listening on 127.0.0.1:${PORT}\n`);
  });
