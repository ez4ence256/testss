// Relais « Capture téléphone » : le téléphone envoie des photos du menu Tâches, le PC les récupère.
// JavaScript simple (le Node de production ne sait pas importer src/*.ts). Tout est en mémoire.
// Le code de session est le seul secret : jamais journalisé (ni lui ni les images).
// Protocole : POST /api/phone → {code} ; PC : GET .../events (SSE) ; téléphone : POST .../photo, DELETE .../photo/:id,
// POST .../done ; PC : GET .../photo/:id (lecture unique, l'image est effacée).
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

export const LIMITS = {
  maxPhotoBytes: 3 * 1024 * 1024,
  maxPhotos: 30, // une vidéo donne jusqu'à 24 images
  maxSessions: 200,
  maxTotalBytes: 100 * 1024 * 1024,
  maxListeners: 2,
  ttlMs: 10 * 60 * 1000,
  createPerIpPerMin: 10,
  perIpPerMin: 120,
  heartbeatMs: 25_000,
};

const CODE = /^[A-Za-z0-9]{24}$/;
const ID = /^[0-9a-f]{16}$/;
const TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** @type {Map<string, {created: number, listeners: Set<any>, photos: Map<string, {type: string, buf: Buffer}>, done: boolean}>} */
const sessions = new Map();
/** @type {Map<string, {start: number, n: number}>} */
const ipsCreate = new Map();
const ipsAll = new Map();
let totalBytes = 0;

function drop(code) {
  const s = sessions.get(code);
  if (!s) return;
  for (const p of s.photos.values()) totalBytes -= p.buf.length;
  for (const l of s.listeners) l.res.end();
  s.gone = true;
  sessions.delete(code);
}

/** Vide tout (tests). */
export function resetPhone() {
  for (const code of [...sessions.keys()]) drop(code);
  ipsCreate.clear();
  ipsAll.clear();
  totalBytes = 0;
}

/** Vieillit une session (tests de TTL). */
export function ageSession(code, ms) {
  const s = sessions.get(code);
  if (s) s.created -= ms;
}

/** Vrai si les premiers octets sont ceux d'un JPEG, d'un PNG ou d'un WebP. */
export function looksLikeImage(buf) {
  if (buf.length < 12) return false;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webp = buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  return jpeg || png || webp;
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

/** Fenêtre fixe d'une minute ; renvoie false si la limite est dépassée. */
function hit(map, key, limit, now) {
  const slot = map.get(key) ?? { start: now, n: 0 };
  map.set(key, slot);
  if (now - slot.start >= 60_000) {
    slot.start = now;
    slot.n = 0;
  }
  return ++slot.n <= limit;
}

// derrière un proxy : la dernière entrée de X-Forwarded-For est celle ajoutée par le proxy de confiance
function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim();
  return fwd || req.socket.remoteAddress || "?";
}

/** Lit le corps binaire (3 Mo max) ; rejette avec { status, error }. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > LIMITS.maxPhotoBytes) {
      req.resume();
      return reject({ status: 413, error: "too-large" });
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > LIMITS.maxPhotoBytes) {
        failed = true;
        reject({ status: 413, error: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => !failed && resolve(Buffer.concat(chunks)));
    req.on("error", () => !failed && reject({ status: 400, error: "bad-request" }));
  });
}

function send(l, name, data) {
  if (l.res.writableEnded || l.res.destroyed) return; // connexion déjà fermée : jamais d'exception
  l.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
function notify(s, name, data) {
  for (const l of s.listeners) send(l, name, data);
}

function create(req, res) {
  if (!hit(ipsCreate, clientIp(req), LIMITS.createPerIpPerMin, Date.now())) {
    return json(res, 429, { error: "rate-limited" }, { "Retry-After": "60" });
  }
  if (sessions.size >= LIMITS.maxSessions) return json(res, 503, { error: "too-many-sessions" }, { "Retry-After": "60" });
  let code = "";
  for (const b of randomBytes(24)) code += ALPHABET[b % 62]; // léger biais (256 % 62), sans effet pratique sur 24 caractères
  sessions.set(code, { created: Date.now(), listeners: new Set(), photos: new Map(), done: false, gone: false });
  json(res, 200, { code });
}

function listen(req, res, s) {
  if (s.listeners.size >= LIMITS.maxListeners) return json(res, 429, { error: "too-many-listeners" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const l = { res };
  res.on("error", () => {}); // coupure brutale du client : gérée par « close »
  s.listeners.add(l);
  res.write("retry: 3000\n\n");
  send(l, "photos", { count: s.photos.size });
  if (s.done) send(l, "done", { ids: [...s.photos.keys()] }); // PC reconnecté après la fin
  const beat = setInterval(() => res.write(": ping\n\n"), LIMITS.heartbeatMs);
  req.on("close", () => {
    clearInterval(beat);
    s.listeners.delete(l);
  });
}

async function upload(req, res, s) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!TYPES.includes(type)) return json(res, 415, { error: "bad-type" });
  if (s.done) return json(res, 409, { error: "already-done" });
  if (s.photos.size >= LIMITS.maxPhotos) return json(res, 409, { error: "too-many-photos" });
  const buf = await readBody(req);
  if (!looksLikeImage(buf)) return json(res, 400, { error: "bad-image" });
  // revérifié après la lecture : la session a pu expirer ou se remplir entre-temps
  if (s.gone || s.done || s.photos.size >= LIMITS.maxPhotos) return json(res, 409, { error: "gone" });
  if (totalBytes + buf.length > LIMITS.maxTotalBytes) return json(res, 503, { error: "memory-full" }, { "Retry-After": "60" });
  const id = randomBytes(8).toString("hex");
  s.photos.set(id, { type, buf });
  totalBytes += buf.length;
  notify(s, "photos", { count: s.photos.size });
  json(res, 200, { id });
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Page ouverte en localhost sur la machine du serveur (derrière un proxy, l'hôte est le domaine public : refusé). */
function isLocalRequest(req) {
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && ["localhost", "127.0.0.1", "::1"].includes(host);
}
/** Adresses IPv4 du PC sur le réseau local, avec le port de la page. */
function lanOrigins(req) {
  const port = /:(\d+)$/.exec(String(req.headers.host ?? ""))?.[1];
  const out = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(`http://${a.address}${port ? `:${port}` : ""}`);
  return out;
}

/** Gestionnaire HTTP pour /api/phone/... ; renvoie false si l'URL n'est pas la sienne. */
export function handlePhone(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ["api","phone",code,action,id]
  if (parts[0] !== "api" || parts[1] !== "phone") return false;
  const [, , code, action, id] = parts;
  const m = req.method;
  const fail = (e) => json(res, e?.status ?? 500, { error: e?.error ?? "server-error" });
  const reply = (status, body, extra) => {
    req.resume(); // corps non lu : on le vide pour ne pas bloquer la connexion
    json(res, status, body, extra);
  };
  if (!hit(ipsAll, clientIp(req), LIMITS.perIpPerMin, Date.now())) {
    reply(429, { error: "rate-limited" }, { "Retry-After": "60" });
    return true;
  }
  if (parts.length === 2) {
    if (m === "POST") create(req, res);
    else reply(404, { error: "not-found" });
    return true;
  }
  // test en local : le PC ne peut pas deviner son adresse réseau, le serveur la donne pour le QR code
  if (parts.length === 3 && code === "lan" && m === "GET") {
    reply(200, { origins: isLocalRequest(req) ? lanOrigins(req) : [] });
    return true;
  }
  if (!CODE.test(code)) {
    reply(400, { error: "bad-code" });
    return true;
  }
  const s = sessions.get(code);
  if (s && Date.now() - s.created > LIMITS.ttlMs) drop(code);
  if (!s || s.gone) {
    reply(404, { error: "unknown-session" });
    return true;
  }
  if (id !== undefined && !ID.test(id)) {
    reply(400, { error: "bad-id" });
    return true;
  }

  if (m === "GET" && action === "events" && parts.length === 4) listen(req, res, s);
  else if (m === "POST" && action === "photo" && parts.length === 4) upload(req, res, s).catch(fail);
  else if (m === "DELETE" && action === "photo" && parts.length === 5) {
    const p = s.photos.get(id);
    if (s.done) reply(409, { error: "already-done" });
    else if (!p) reply(404, { error: "not-found" });
    else {
      s.photos.delete(id);
      totalBytes -= p.buf.length;
      notify(s, "photos", { count: s.photos.size });
      reply(200, { ok: true });
    }
  } else if (m === "POST" && action === "done" && parts.length === 4) {
    if (s.photos.size === 0) reply(400, { error: "no-photos" });
    else {
      s.done = true;
      notify(s, "done", { ids: [...s.photos.keys()] });
      reply(200, { ok: true });
    }
  } else if (m === "GET" && action === "photo" && parts.length === 5) {
    const p = s.photos.get(id);
    if (!p) reply(404, { error: "not-found" });
    else {
      s.photos.delete(id); // lecture unique
      totalBytes -= p.buf.length;
      res.writeHead(200, { "Content-Type": p.type, "Content-Length": p.buf.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(p.buf);
      if (s.done && s.photos.size === 0) drop(code);
    }
  } else reply(404, { error: "not-found" });
  return true;
}

// Nettoyage : sessions expirées, compteurs d'IP périmés.
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) if (now - s.created > LIMITS.ttlMs) drop(code);
  for (const map of [ipsCreate, ipsAll]) for (const [ip, s] of map) if (now - s.start >= 60_000) map.delete(ip);
}, 60_000).unref();
