/**
 * carousel.js — the Gulch and Medley carousel screens (1920×1080), ?loc=the-gulch | medley.
 *
 * Rotation: Dropbox carousel photos (25 s each), with one "feature" after every two photos
 * (20 s). Features take turns: each current promo slide, then the staff picks.
 *
 * Data (all published by the menu-build job except the staff picks):
 *   ../data/carousel.json         photos from Dropbox /Digital Media/FDB Screen Carousel
 *                                 (subfolders included); images in ../carousel-photos/
 *   ../data/promos-{loc}.json     promo slides from Dropbox /Digital Media/Promos/<Store>
 *                                 and /All Stores; images in ../promos/
 *   ../data/{loc}.json            today's pastry menu: prices, Square photos, descriptions
 *   ../data/bev-{loc}.json        drinks, for drink picks
 *   staff-picks-{loc}.json        written by admin.html's Staff picks tab (repo main branch)
 *
 * Fully Kiosk reloads the page every 10 minutes, so the position in the rotation is kept in
 * localStorage and the next slide follows on after a reload instead of starting over.
 *
 * Test options: ?hold=photo|promo|picks shows the first slide of that kind and stays there;
 * ?every=<seconds> sets every slide's time.
 */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const LOC    = params.get("loc") || "the-gulch";
  const HOLD   = params.get("hold");
  const EVERY  = Number(params.get("every")) * 1000 || 0;
  const PHOTO_MS    = EVERY || 25000;
  const FEATURE_MS  = EVERY || 20000;
  const PHOTOS_BETWEEN = 2;
  const REFRESH_MS  = 5 * 60 * 1000;
  const FADE_MS     = 1400;
  const IMAGE_WAIT_MS = 8000;
  const POS_KEY = `fdb-carousel-${LOC}`;

  const URLS = {
    carousel: "../data/carousel.json",
    promos:   `../data/promos-${LOC}.json`,
    menu:     `../data/${LOC}.json`,
    bev:      `../data/bev-${LOC}.json`,
    picks:    `https://raw.githubusercontent.com/jwal7000/menu-display-horizontal/main/public/staff-picks-${LOC}.json`,
  };

  const state = { photos: [], promos: [], picks: [], menu: null, bev: null };
  const stage = document.getElementById("stage");

  // ── helpers ────────────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== "") e.textContent = text;
    return e;
  }

  function image(src, cls) {
    const i = el("img", cls);
    i.alt = "";
    i.src = src;
    return i;
  }

  async function getJson(url) {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  /** Resolves once every image in `node` has loaded or failed, or after IMAGE_WAIT_MS. */
  function imagesReady(node, urls) {
    const all = [...node.querySelectorAll("img")].map(i => i.src).concat(urls || []);
    const wait = all.map(src => new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = src; }));
    return Promise.race([Promise.all(wait), new Promise(r => setTimeout(r, IMAGE_WAIT_MS))]);
  }

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // ── data ───────────────────────────────────────────────────────────────────

  async function refresh() {
    await Promise.all([
      getJson(URLS.carousel).then(d => { state.photos = Array.isArray(d.photos) ? d.photos : []; }).catch(() => {}),
      getJson(URLS.promos).then(d => { state.promos = Array.isArray(d.slides) ? d.slides : []; }).catch(() => {}),
      getJson(URLS.menu).then(d => { state.menu = d; }).catch(() => {}),
      getJson(URLS.bev).then(d => { state.bev = d; }).catch(() => {}),
      getJson(URLS.picks).then(d => { state.picks = Array.isArray(d.picks) ? d.picks : []; }).catch(() => {}),
    ]);
  }

  // ── staff picks ────────────────────────────────────────────────────────────

  /** { price, image, description } for an item on today's pastry menu or drinks list, else null. */
  function findItem(name) {
    for (const s of (state.menu && state.menu.sections) || []) {
      for (const i of s.items || []) {
        if (i.name === name) return { price: i.price, image: i.photo_url, description: i.description };
      }
    }
    for (const s of (state.bev && state.bev.sections) || []) {
      const items = [...(s.items || []), ...(s.sub_sections || []).flatMap(x => x.items || [])];
      for (const i of items) if (i.name === name) return { price: i.price };
    }
    return null;
  }

  /** Picks whose item is on today's menu (sold out or not), at most three. */
  function currentPicks() {
    return state.picks
      .map(p => ({ ...p, found: p && p.item ? findItem(p.item) : null }))
      .filter(p => p.found)
      .slice(0, 3);
  }

  /** One line: a leading "(Made with vegan ingredients)" would use it all up. */
  function shortDescription(text) {
    const t = String(text || "").replace(/^\([^)]*\)\s*/, "").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  }

  /** Square photo cropped to fill, or the logo on white when there's none or it won't load. */
  function pickPhoto(src) {
    const frame = el("div", "sp-photo");
    const img = el("img");
    img.alt = "";
    const fallback = () => { img.onerror = null; img.src = "../logo.png"; frame.classList.add("none"); };
    if (src) { img.onerror = fallback; img.src = src; } else fallback();
    frame.append(img);
    return frame;
  }

  function header(title, sub) {
    const hd = el("div", "hd"), left = el("div");
    left.append(el("h1", null, title), el("p", null, sub));
    hd.append(left, image("../logo.png"));
    return hd;
  }

  function picksSlide(picks) {
    const s = el("div", "slide designed");
    const store = (state.menu && state.menu.location_name) || "";
    s.append(header("Staff Picks", store ? `Our team's favorites at ${store}` : "Our team's favorites"));
    const grid = el("div", `sp-grid n${picks.length}`);
    for (const p of picks) {
      const c = el("div", "sp-card");
      c.append(pickPhoto(p.found.image), el("div", "sp-item", p.item),
               el("div", "sp-desc", shortDescription(p.found.description) || " "),
               el("div", "sp-price", p.found.price || " "));
      c.append(p.note ? el("div", "sp-note", p.note) : el("div", "sp-spacer"));
      const who = el("div", "sp-who", p.staff);
      if (p.role) who.append(el("small", null, p.role));
      c.append(who);
      grid.append(c);
    }
    s.append(grid);
    return s;
  }

  // ── promos and photos ──────────────────────────────────────────────────────

  function currentPromos() {
    const d = today();
    return state.promos.filter(p => p && p.image && (!p.starts || p.starts <= d) && (!p.ends || p.ends >= d));
  }

  function promoSlide(p) {
    const src = `../promos/${p.image}`;
    if (p.type === "card") {
      const s = el("div", "slide card"), pic = el("div", "pic"), txt = el("div", "txt");
      pic.style.backgroundImage = `url("${src}")`;
      if (p.tag) txt.append(el("span", "tag", p.tag));
      txt.append(el("h2", null, p.title));
      if (p.price) txt.append(el("div", "price", p.price));
      if (p.body) txt.append(el("div", "body", p.body));
      txt.append(image("../logo.png", "logo"));
      s.append(pic, txt);
      s._urls = [src];
      return s;
    }
    const s = el("div", "slide graphic");
    s.append(image(src));
    return s;
  }

  function photoSlide(photo) {
    const src = `../carousel-photos/${photo.image}`;
    const s = el("div", "slide photo");
    s.style.backgroundImage = `url("${src}")`;
    s._urls = [src];
    return s;
  }

  function emptySlide() {
    const s = el("div", "slide empty");
    s.append(image("../logo.png"));
    return s;
  }

  // ── rotation ───────────────────────────────────────────────────────────────

  /** { photo, feature, since }: next photo index, next feature index, photos since a feature. */
  function loadPos() {
    try { return Object.assign({ photo: 0, feature: 0, since: 0 }, JSON.parse(localStorage.getItem(POS_KEY)) || {}); }
    catch { return { photo: 0, feature: 0, since: 0 }; }
  }
  const pos = loadPos();
  const savePos = () => { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* private mode */ } };

  function features() {
    const list = currentPromos().map(p => ({ kind: "promo", label: `promo ${p.source}`, build: () => promoSlide(p) }));
    const picks = currentPicks();
    if (picks.length) list.push({ kind: "picks", label: `picks (${picks.length})`, build: () => picksSlide(picks) });
    return list;
  }

  /** The next slide to show: { node, ms }. Advances and saves the position. */
  function nextSlide() {
    const feats = features();
    const photos = state.photos;

    if (HOLD) {
      if (HOLD === "photo" && photos.length) return { node: photoSlide(photos[0]), ms: PHOTO_MS };
      const f = feats.find(x => x.kind === HOLD);
      return { node: f ? f.build() : emptySlide(), ms: FEATURE_MS };
    }

    if (feats.length && (!photos.length || pos.since >= PHOTOS_BETWEEN)) {
      const f = feats[pos.feature % feats.length];
      pos.feature = (pos.feature + 1) % feats.length;
      pos.since = 0;
      savePos();
      return { node: f.build(), ms: FEATURE_MS, label: f.label };
    }
    if (photos.length) {
      const p = photos[pos.photo % photos.length];
      pos.photo = (pos.photo + 1) % photos.length;
      pos.since += 1;
      savePos();
      return { node: photoSlide(p), ms: PHOTO_MS, label: `photo ${p.source}` };
    }
    return { node: emptySlide(), ms: FEATURE_MS, label: "empty" };
  }

  async function show({ node, ms, label }) {
    await imagesReady(node, node._urls);
    console.info(`[carousel] ${label || "hold"}`);
    const old = [...stage.children];
    stage.append(node);
    void node.offsetWidth;                       // start the fade from opacity 0
    node.classList.add("active");
    old.forEach(o => { o.classList.remove("active"); o.classList.add("leaving"); });
    setTimeout(() => old.forEach(o => o.remove()), FADE_MS);
    setTimeout(() => show(nextSlide()), ms);
  }

  refresh().then(() => {
    show(nextSlide());
    setInterval(refresh, REFRESH_MS);
  });
})();
