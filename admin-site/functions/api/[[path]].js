// Admin site backend. Every request needs the admin password.
// Needs: D1 binding "DB", R2 binding "BUCKET", secret "ADMIN_PASSWORD" (see README.md).
const J = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
const STATUSES = ["New", "Applied", "Waitlist", "Approved", "Contacted", "Paid", "Declined", "Cancelled"];
const NOT_HELD = "('Cancelled','Waitlist','Applied','Declined')"; // statuses that don't use up a booth
const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
const CATS = ["Food & beverage", "Jewellery & accessories", "Fashion & apparel", "Art & prints", "Home & living", "Beauty & wellness", "Plants & florals", "Kids & toys", "Stationery & crafts", "Zero-waste & sustainable", "Other"];
const cFields = (c, cats = CATS) => [String(c.name || "").trim().slice(0, 100), String(c.business || "").slice(0, 100),
  cats.includes(c.category) ? c.category : (cats.includes("Other") ? "Other" : cats[cats.length - 1]), String(c.phone || "").slice(0, 30),
  String(c.email || "").slice(0, 120), String(c.social || "").slice(0, 200), String(c.notes || "").slice(0, 500)];
// Site content (hero, FAQ, contact details, categories...) saved from the admin. Safe if the table doesn't exist yet.
async function getSite(db) {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'site'").first();
    return row ? parse(row.value, {}) : {};
  } catch { return {}; }
}
const catsOf = (site) => (Array.isArray(site.cats) && site.cats.length ? site.cats : CATS);
// Keep only the fields the public site understands, trimmed to sensible lengths.
const T = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
function cleanSite(x) {
  x = x && typeof x === "object" ? x : {};
  const h = x.hero || {}, c = x.contact || {}, bn = x.banner || {};
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const key = (k) => (typeof k === "string" && /^[\w./-]{1,120}$/.test(k) ? k : "");
  const cats = [...new Set(arr(x.cats, 40).map((v) => T(v, 40)).filter(Boolean))];
  return {
    hero: { title: T(h.title, 140), text: T(h.text, 600), photos: arr(h.photos, 3).map(key) },
    contact: { wa: T(c.wa, 20).replace(/\D/g, ""), email: T(c.email, 120), ig: T(c.ig, 200), fb: T(c.fb, 200) },
    faq: arr(x.faq, 30).map((f) => ({ q: T(f && f.q, 160), a: T(f && f.a, 1500) })).filter((f) => f.q && f.a),
    themes: arr(x.themes, 3).map((t) => ({ name: T(t && t.name, 40), text: T(t && t.text, 300) })),
    banner: { on: !!bn.on, text: T(bn.text, 200) },
    cats: cats.length ? cats : CATS,
    siteUrl: T(x.siteUrl, 200),
    terms: { text: T(x.terms && x.terms.text, 8000), ver: "" },
    gallery: arr(x.gallery, 12).map((g) => ({ key: key(g && g.key), caption: T(g && g.caption, 120) })).filter((g) => g.key),
    quotes: arr(x.quotes, 8).map((q) => ({ text: T(q && q.text, 400), name: T(q && q.name, 100) })).filter((q) => q.text),
  };
}
const evOut = (r) => ({ ...r, booths: parse(r.booths, []), images: parse(r.images, []) });

function evFields(e) {
  const booths = (Array.isArray(e.booths) ? e.booths : []).slice(0, 12).map((b) => ({
    name: String(b.name || "").slice(0, 60), size: String(b.size || "").slice(0, 40),
    weekend: +b.weekend || 0, week: +b.week || 0,
  }));
  const images = (Array.isArray(e.images) ? e.images : []).slice(0, 24)
    .filter((i) => i && typeof i.key === "string")
    .map((i) => ({ key: i.key, kind: i.kind === "layout" ? "layout" : "space" }));
  return [e.title, e.kind || "Craft fair", e.theme || "", e.start_date, e.end_date || e.start_date,
    e.venue || "", +e.slots || 0, e.description || "", JSON.stringify(booths),
    String(e.includes || "").slice(0, 2000), JSON.stringify(images), e.apply ? 1 : 0, String(e.pack || "").trim().slice(0, 6000)];
}

// HitPay helpers. Uses the sandbox until you set HITPAY_BASE to the live address (see README).
const expose = (msg) => Object.assign(new Error(msg), { expose: true });
async function hp(env, path, init = {}) {
  if (!env.HITPAY_API_KEY) throw expose("HitPay isn't connected yet. Add the HITPAY_API_KEY secret (see README).");
  const base = (env.HITPAY_BASE || "https://api.sandbox.hit-pay.com/v1").replace(/\/$/, "");
  const res = await fetch(base + path, {
    ...init, headers: { "X-BUSINESS-API-KEY": env.HITPAY_API_KEY, ...(init.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw expose(String(j.message || "HitPay refused the request") + " (" + res.status + ")");
  return j;
}
const isPaid = (j) =>
  ["completed", "succeeded"].includes(String(j.status).toLowerCase()) ||
  (j.payments || []).some((p) => ["completed", "succeeded"].includes(String(p.status).toLowerCase()));

export async function onRequest({ request: r, env, params }) {
  const [a, id, sub] = params.path || [];
  const m = r.method;
  const db = env.DB;
  const admin = env.ADMIN_PASSWORD && r.headers.get("authorization") === "Bearer " + env.ADMIN_PASSWORD;

  try {
    // Photos are public anyway, so <img> tags can load them without the password.
    if (a === "img" && id && m === "GET") {
      const o = await env.BUCKET.get(id);
      if (!o) return new Response("Not found", { status: 404 });
      return new Response(o.body, {
        headers: {
          "content-type": o.httpMetadata?.contentType || "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    // ---- everything below needs the password ----
    if (!admin) return J({ error: "Wrong or missing password." }, 401);

    if (a === "ping") {
      let upgraded = true;
      try { await db.prepare("SELECT show_public, terms_at FROM bookings LIMIT 1").first(); await db.prepare("SELECT apply, pack FROM events LIMIT 1").first(); await db.prepare("SELECT phone FROM subscribers LIMIT 1").first(); } catch { upgraded = false; }
      return J({ ok: true, upgraded });
    }

    // ---- PayNow payment link for one booking (fixed amount) ----
    if (a === "bookings" && id && sub === "pay" && m === "POST") {
      const b = await db.prepare(`SELECT b.*, e.title AS event_title FROM bookings b
                                  LEFT JOIN events e ON e.id = b.event_id WHERE b.id = ?`).bind(id).first();
      if (!b) return J({ error: "Booking not found." }, 404);
      const { regenerate } = await r.json().catch(() => ({}));
      if (["Applied", "Waitlist", "Declined", "Cancelled"].includes(b.status)) return J({ error: `This booking is "${b.status}". Set it to Approved (or Contacted) before sending a payment link.` }, 400);
      if (b.pay_url && !regenerate) return J({ url: b.pay_url });
      if (!(b.total > 0)) return J({ error: "This booking has no price, so there is nothing to charge." }, 400);
      const form = new URLSearchParams();
      form.set("amount", Number(b.total).toFixed(2));
      form.set("currency", "SGD");
      form.append("payment_methods[]", "paynow_online");
      form.set("name", b.name);
      if (b.email) form.set("email", b.email);
      form.set("purpose", `${b.event_title || "Event"}: ${b.qty} x ${b.booth_type || "booth"}, ${b.duration}`.slice(0, 200));
      form.set("reference_number", "BYE-" + b.id);
      // Link stops working after a set time (HitPay reads this in Singapore time). Default 72 hours; change with the PAY_EXPIRY_HOURS setting.
      const hrs = Math.min(Math.max(Number(env.PAY_EXPIRY_HOURS) || 72, 1), 24 * 60);
      form.set("expiry_date", new Date(Date.now() + (hrs + 8) * 3600e3).toISOString().slice(0, 19).replace("T", " "));
      if (env.PUBLIC_URL) form.set("webhook", env.PUBLIC_URL.replace(/\/$/, "") + "/api/hitpay"); // lets HitPay mark it Paid by itself
      const j = await hp(env, "/payment-requests", { method: "POST", body: form });
      if (!j.id || !j.url) throw expose("HitPay didn't return a payment link.");
      await db.prepare("UPDATE bookings SET pay_id = ?, pay_url = ? WHERE id = ?").bind(j.id, j.url, id).run();
      return J({ url: j.url }, 201);
    }
    if (a === "bookings" && id && sub === "pay" && m === "GET") {
      const b = await db.prepare("SELECT pay_id FROM bookings WHERE id = ?").bind(id).first();
      if (!b || !b.pay_id) return J({ status: "none", paid: false });
      const j = await hp(env, "/payment-requests/" + encodeURIComponent(b.pay_id));
      const paid = isPaid(j);
      if (paid) await db.prepare("UPDATE bookings SET status = 'Paid' WHERE id = ?").bind(id).run();
      return J({ status: j.status || "unknown", paid });
    }

    if (a === "hooklog" && m === "GET") {
      const cur = await db.prepare("SELECT value FROM settings WHERE key = 'hooklog'").first();
      return J(cur ? JSON.parse(cur.value) : []);
    }

    if (a === "events" && m === "GET") {
      const { results } = await db
        .prepare(
          `SELECT e.*, COALESCE((SELECT SUM(qty) FROM bookings b
             WHERE b.event_id = e.id AND b.status NOT IN ${NOT_HELD}), 0) AS booked
           FROM events e ORDER BY start_date`
        ).all();
      return J(results.map(evOut));
    }

    if (a === "upload" && m === "POST") {
      const type = r.headers.get("content-type") || "";
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[type];
      if (!ext) return J({ error: "Please use JPG, PNG or WebP images." }, 400);
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 6e6) return J({ error: "That image is too large (6 MB max)." }, 413);
      const key = crypto.randomUUID() + "." + ext;
      await env.BUCKET.put(key, buf, { httpMetadata: { contentType: type } });
      return J({ key }, 201);
    }

    if (a === "bookings" && m === "GET") {
      const { results } = await db
        .prepare(`SELECT b.*, e.title AS event_title FROM bookings b
                  LEFT JOIN events e ON e.id = b.event_id ORDER BY b.id DESC`).all();
      return J(results);
    }
    if (a === "bookings" && id && m === "PATCH") {
      const body = await r.json();
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) return J({ error: "Bad status." }, 400);
        await db.prepare("UPDATE bookings SET status = ? WHERE id = ?").bind(body.status, id).run();
      }
      if (body.show_public !== undefined) {
        await db.prepare("UPDATE bookings SET show_public = ? WHERE id = ?").bind(body.show_public ? 1 : 0, id).run();
      }
      return J({ ok: true });
    }
    // Check every unpaid payment link with HitPay in one go (safety net if the automatic update ever misses one).
    if (a === "payments" && id === "check" && m === "POST") {
      const { results } = await db.prepare("SELECT id, pay_id FROM bookings WHERE pay_id != '' AND status NOT IN ('Paid','Cancelled','Declined') LIMIT 40").all();
      let paid = 0;
      for (const b of results) {
        try {
          const j = await hp(env, "/payment-requests/" + encodeURIComponent(b.pay_id));
          if (isPaid(j)) { await db.prepare("UPDATE bookings SET status = 'Paid' WHERE id = ?").bind(b.id).run(); paid++; }
        } catch (e) { if (results.length === 1) throw e; }
      }
      return J({ checked: results.length, paid });
    }
    if (a === "bookings" && id && m === "DELETE") {
      await db.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
      return J({ ok: true });
    }

    if (a === "events" && m === "POST") {
      const e = await r.json();
      if (!e.title || !e.start_date) return J({ error: "Title and start date are needed." }, 400);
      await db
        .prepare(`INSERT INTO events (title, kind, theme, start_date, end_date, venue, slots, description, booths, includes, images, apply, pack, pack_token)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...evFields(e), evFields(e)[12] ? crypto.randomUUID().replace(/-/g, "") : "").run();
      return J({ ok: true }, 201);
    }
    if (a === "events" && id && m === "PUT") {
      const e = await r.json();
      if (!e.title || !e.start_date) return J({ error: "Title and start date are needed." }, 400);
      const f = evFields(e);
      const old = await db.prepare("SELECT pack_token FROM events WHERE id = ?").bind(id).first();
      const token = f[12] ? (old && old.pack_token) || crypto.randomUUID().replace(/-/g, "") : "";
      await db
        .prepare(`UPDATE events SET title=?, kind=?, theme=?, start_date=?, end_date=?, venue=?, slots=?,
                  description=?, booths=?, includes=?, images=?, apply=?, pack=?, pack_token=? WHERE id=?`)
        .bind(...f, token, id).run();
      return J({ ok: true });
    }
    if (a === "events" && id && m === "DELETE") {
      const row = await db.prepare("SELECT images FROM events WHERE id = ?").bind(id).first();
      for (const i of parse(row?.images, [])) await env.BUCKET.delete(i.key);
      await db.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
      return J({ ok: true });
    }

    // ---- contacts (vendors and their brand line) ----
    if (a === "contacts" && !id && m === "GET") {
      const { results } = await db.prepare("SELECT * FROM contacts ORDER BY lower(CASE WHEN business != '' THEN business ELSE name END)").all();
      return J(results);
    }
    if (a === "contacts" && !id && m === "POST") {
      const f = cFields(await r.json(), catsOf(await getSite(db)));
      if (!f[0]) return J({ error: "A name is needed." }, 400);
      await db.prepare("INSERT INTO contacts (name, business, category, phone, email, social, notes) VALUES (?,?,?,?,?,?,?)").bind(...f).run();
      return J({ ok: true }, 201);
    }
    if (a === "contacts" && id && m === "PUT") {
      const f = cFields(await r.json(), catsOf(await getSite(db)));
      if (!f[0]) return J({ error: "A name is needed." }, 400);
      await db.prepare("UPDATE contacts SET name=?, business=?, category=?, phone=?, email=?, social=?, notes=? WHERE id=?").bind(...f, id).run();
      return J({ ok: true });
    }
    if (a === "contacts" && id && m === "DELETE") {
      await db.prepare("DELETE FROM contacts WHERE id = ?").bind(id).run();
      return J({ ok: true });
    }

    if (a === "subscribers" && !id && m === "GET") {
      const { results } = await db.prepare("SELECT * FROM subscribers ORDER BY id DESC").all();
      return J(results);
    }
    if (a === "subscribers" && id && m === "DELETE") {
      await db.prepare("DELETE FROM subscribers WHERE id = ?").bind(id).run();
      return J({ ok: true });
    }

    // One file with everything, to keep somewhere safe. Photos stay in R2 and aren't included.
    if (a === "backup" && m === "GET") {
      const all = async (t) => { try { return (await db.prepare(`SELECT * FROM ${t}`).all()).results; } catch { return []; } };
      const out = { saved_at: new Date().toISOString(), events: await all("events"), bookings: await all("bookings"), contacts: await all("contacts"), subscribers: await all("subscribers"), settings: await all("settings") };
      return new Response(JSON.stringify(out, null, 1), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="backyardeventssg-backup-${out.saved_at.slice(0, 10)}.json"` } });
    }

    if (a === "settings" && m === "GET") return J(await getSite(db));
    if (a === "settings" && m === "PUT") {
      const site = cleanSite(await r.json());
      const before = await getSite(db);
      const oldT = before.terms || {};
      site.terms.ver = site.terms.text ? (oldT.text === site.terms.text && oldT.ver ? oldT.ver : new Date().toISOString()) : "";
      await db.prepare("INSERT INTO settings (key, value) VALUES ('site', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify(site)).run();
      return J(site);
    }

    return J({ error: "Not found." }, 404);
  } catch (err) {
    if (err && err.expose) return J({ error: err.message }, 502);
    return J({ error: "Something went wrong on our side." }, 500);
  }
}
