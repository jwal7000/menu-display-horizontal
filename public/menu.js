/**
 * menu.js — Five Daughters Bakery Digital Menu Board
 *
 * Fetches ../output/menu.json, renders the menu, and refreshes every 60s.
 * On fetch failure, keeps the last successful menu and shows a warning banner.
 * No framework dependencies — plain ES2020 JavaScript.
 */

(function () {
  "use strict";

  // ── Config ────────────────────────────────────────────────────────────────

  const MENU_JSON_PATH   = "./menu.json";
  const REFRESH_INTERVAL = 60 * 1000; // 60 seconds

  // ── Element refs ──────────────────────────────────────────────────────────

  const menuRoot         = document.getElementById("menu-root");
  const locationNameEl   = document.getElementById("location-name");
  const connectionWarn   = document.getElementById("connection-warning");
  const footerLocationEl = document.getElementById("footer-location");
  const footerUpdatedEl  = document.getElementById("footer-updated");

  // ── State ─────────────────────────────────────────────────────────────────

  let lastGoodMenu   = null;
  let isFirstLoad    = true;

  // ── Utilities ─────────────────────────────────────────────────────────────

  function formatTimestamp(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatFullTimestamp(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
      + " · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function setWarning(visible) {
    if (visible) {
      connectionWarn.classList.remove("hidden");
      document.body.classList.add("has-warning");
    } else {
      connectionWarn.classList.add("hidden");
      document.body.classList.remove("has-warning");
    }
  }

  // ── DOM builders ─────────────────────────────────────────────────────────

  /**
   * Convert a Dropbox share URL (?dl=0) to a direct image URL (?raw=1).
   * Other URLs are passed through unchanged.
   */
  function resolveImageUrl(url) {
    if (!url) return null;
    if (url.includes("dropbox.com")) {
      // Parse existing query params, keep rlkey (required for /scl/fi/ links), drop dl and st
      const [base, query] = url.split("?");
      const params = new URLSearchParams(query || "");
      params.delete("dl");
      params.delete("st");
      params.set("raw", "1");
      const qs = params.toString();
      return base + (qs ? "?" + qs : "");
    }
    return url;
  }

  /**
   * Build a single item row (<li>).
   * Handles sold-out display: strikethrough + label vs normal price.
   * Shows a thumbnail image if image_url is present.
   */
  function buildItemRow(item) {
    const li = document.createElement("li");
    li.className = "item-row" + (item.sold_out ? " sold-out" : "");

    // ── Thumbnail (if image_url present) ──
    const imageUrl = resolveImageUrl(item.image_url);
    if (imageUrl) {
      li.classList.add("has-image");
      const img = document.createElement("img");
      img.className = "item-thumb";
      img.src = imageUrl;
      img.alt = item.name;
      img.loading = "lazy";
      img.onerror = () => {
        // Hide broken images gracefully
        img.style.display = "none";
        li.classList.remove("has-image");
      };
      li.appendChild(img);
    }

    // ── Text content wrapper ──
    const textWrap = document.createElement("span");
    textWrap.className = "item-text";

    const nameEl = document.createElement("span");
    nameEl.className = "item-name";
    nameEl.textContent = item.name;

    const dotsEl = document.createElement("span");
    dotsEl.className = "item-dots";
    dotsEl.setAttribute("aria-hidden", "true");

    const priceEl = document.createElement("span");
    if (item.sold_out) {
      priceEl.className = "item-sold-out-label";
      priceEl.textContent = "Sold Out";
    } else {
      priceEl.className = "item-price";
      priceEl.textContent = item.price ?? "";
    }

    textWrap.appendChild(nameEl);
    textWrap.appendChild(dotsEl);
    textWrap.appendChild(priceEl);
    li.appendChild(textWrap);

    // If item has multiple variations, append them as sub-rows
    if (Array.isArray(item.variations) && item.variations.length > 1) {
      li.classList.add("has-variations");

      // Remove dot leader from parent row when showing variations
      dotsEl.style.display = "none";
      priceEl.style.display = "none";

      const varList = document.createElement("ul");
      varList.className = "item-variations";

      for (const v of item.variations) {
        const varLi = document.createElement("li");
        varLi.className = "variation-row" + (v.sold_out ? " sold-out" : "");

        const vName = document.createElement("span");
        vName.className = "variation-name";
        vName.textContent = v.variation_name ?? "";

        const vDots = document.createElement("span");
        vDots.className = "variation-dots";
        vDots.setAttribute("aria-hidden", "true");

        const vPrice = document.createElement("span");
        if (v.sold_out) {
          vPrice.className = "variation-sold-out-label";
          vPrice.textContent = "Sold Out";
        } else {
          vPrice.className = "variation-price";
          vPrice.textContent = v.price ?? "";
        }

        varLi.appendChild(vName);
        varLi.appendChild(vDots);
        varLi.appendChild(vPrice);
        varList.appendChild(varLi);
      }

      li.appendChild(varList);
    }

    return li;
  }

  /**
   * Build a section card (<div.section-card>).
   */
  function buildSectionCard(section) {
    const card = document.createElement("div");
    card.className = "section-card";

    const header = document.createElement("div");
    header.className = "section-header";

    const title = document.createElement("h2");
    title.className = "section-name";
    title.textContent = section.name;

    header.appendChild(title);
    card.appendChild(header);

    const list = document.createElement("ul");
    list.className = "item-list";
    list.setAttribute("aria-label", section.name + " items");

    const items = section.items ?? [];
    if (items.length === 0) {
      // Show empty state instead of skipping — keeps the section visible
      const empty = document.createElement("p");
      empty.className = "section-empty";
      empty.textContent = "Nothing available right now";
      card.appendChild(empty);
      return card;
    }

    for (const item of items) {
      list.appendChild(buildItemRow(item));
    }

    card.appendChild(list);
    return card;
  }

  /**
   * Render the full menu from a menu.json data object.
   */
  function renderMenu(data) {
    // Update header and footer meta
    const locName = data.location_name ?? "";
    const ts      = data.generated_at ?? "";
    locationNameEl.textContent  = locName;
    if (footerLocationEl) footerLocationEl.textContent = locName;
    if (footerUpdatedEl)  footerUpdatedEl.textContent  = ts ? "Last updated " + formatFullTimestamp(ts) : "";

    // Build section grid
    const grid = document.createElement("div");
    grid.className = "sections-grid";

    const sections = data.sections ?? [];
    let renderedCount = 0;
    const skipIdx = new Set();

    for (let i = 0; i < sections.length; i++) {
      if (skipIdx.has(i)) continue;

      const section = sections[i];

      // Stack Paleo directly below Rolls in one grid cell
      if (section.name === "Rolls") {
        const paleoIdx = sections.findIndex((s, j) => j > i && s.name === "Paleo");
        if (paleoIdx !== -1) {
          const stack = document.createElement("div");
          stack.className = "section-stack";
          stack.appendChild(buildSectionCard(section));
          stack.appendChild(buildSectionCard(sections[paleoIdx]));
          grid.appendChild(stack);
          skipIdx.add(paleoIdx);
          renderedCount++;
          continue;
        }
      }

      const card = buildSectionCard(section);
      if (card) {
        grid.appendChild(card);
        renderedCount++;
      }
    }

    if (renderedCount === 0) {
      const empty = document.createElement("div");
      empty.className = "loading-state";
      empty.textContent = "No menu items available.";
      menuRoot.innerHTML = "";
      menuRoot.appendChild(empty);
      return;
    }

    // Build left content area
    const content = document.createElement("div");
    content.className = "menu-content";
    content.appendChild(grid);

    // Build right promo sidebar
    const promo = document.createElement("div");
    promo.className = "promo-panel";
    const promoImg = document.createElement("img");
    promoImg.className = "promo-img";
    promoImg.src = resolveImageUrl("https://www.dropbox.com/scl/fi/7jomjwnpcaedyyxfh2vpn/Box-Design_Vertical.png?rlkey=sfx0dbr7r8tbgcvouik319926&dl=0");
    promoImg.alt = "Build Your Own Box";
    promo.appendChild(promoImg);

    // Swap in (avoids flash — build off-DOM first)
    menuRoot.innerHTML = "";
    menuRoot.appendChild(content);
    menuRoot.appendChild(promo);
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  async function fetchMenu() {
    // Show pulse on the timestamp during refresh (after first load)
    if (!isFirstLoad) {
      document.body.classList.add("refreshing");
    }

    try {
      // Cache-bust so the browser always fetches the latest file
      const url      = MENU_JSON_PATH + "?t=" + Date.now();
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      lastGoodMenu = data;
      renderMenu(data);
      setWarning(false);
      isFirstLoad = false;

    } catch (err) {
      console.warn("[menu.js] Failed to load menu.json:", err.message);

      if (lastGoodMenu) {
        // Keep showing the last good menu; show warning
        setWarning(true);
      } else {
        // Very first load failed — show an error state
        menuRoot.innerHTML = "";
        const errEl = document.createElement("div");
        errEl.className = "loading-state";
        errEl.textContent = "Unable to load menu. Retrying…";
        menuRoot.appendChild(errEl);
        setWarning(true);
      }
    } finally {
      document.body.classList.remove("refreshing");
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  // Initial load
  fetchMenu();

  // Refresh on interval
  setInterval(fetchMenu, REFRESH_INTERVAL);

})();
