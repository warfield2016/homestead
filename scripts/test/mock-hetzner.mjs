// A stand-in for api.hetzner.cloud, shaped like the real responses (docs.hetzner.cloud),
// so command 0 can be exercised without creating anything. Records every write.
import { createServer } from "node:http";

const types = [
  { id: 1, name: "cx23", cores: 2, memory: 4, architecture: "x86", cpu_type: "shared", deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.0080" }, price_monthly: { gross: "4.99" } }] },
  { id: 2, name: "cax31", cores: 8, memory: 16, architecture: "arm", cpu_type: "shared", deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.0256" }, price_monthly: { gross: "15.99" } }] },
  { id: 3, name: "ccx23", cores: 4, memory: 16, architecture: "x86", cpu_type: "dedicated", deprecation: null, prices: [{ location: "fsn1", price_hourly: { gross: "0.0400" }, price_monthly: { gross: "24.99" } }] },
  { id: 4, name: "cx42", cores: 8, memory: 16, architecture: "x86", cpu_type: "shared", deprecation: { announced: "2025-10-01" }, prices: [{ location: "fsn1", price_hourly: { gross: "0.01" }, price_monthly: { gross: "9.00" } }] },
];
const writes = [];
let nextId = 100;

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== "Bearer test-token") return send(401, { error: { message: "unauthorized" } });
    if (req.method !== "GET") writes.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null });
    const p = url.pathname.replace(/^\/v1/, "");
    if (p === "/server_types") return send(200, { server_types: types });
    if (p === "/datacenters") return send(200, { datacenters: [{ name: "fsn1-dc14", location: { name: "fsn1" }, server_types: { available: [1, 2, 3, 4] } }] });
    if (p === "/pricing") return send(200, { pricing: { currency: "EUR", volume: { price_per_gb_month: { gross: "0.0524" } } } });
    if (p === "/ssh_keys") return send(201, { ssh_key: { id: nextId++ } });
    if (p === "/firewalls") return send(201, { firewall: { id: nextId++ } });
    if (p === "/volumes") { const id = nextId++; return send(201, { volume: { id, linux_device: `/dev/disk/by-id/scsi-0HC_Volume_${id}` } }); }
    if (p === "/servers") return send(201, { server: { id: nextId++, status: "initializing", public_net: { ipv4: { ip: "203.0.113.7" } } } });
    if (req.method === "DELETE") return send(200, { action: { id: nextId++ } });
    if (p.startsWith("/servers/")) return send(200, { server: { status: "running" } });
    if (p.startsWith("/volumes/")) return send(200, { volume: { server: null } });
    if (p === "/_writes") return send(200, writes);
    send(404, { error: { message: `mock has no ${p}` } });
  });
}).listen(Number(process.env.PORT ?? 8799), "127.0.0.1");
