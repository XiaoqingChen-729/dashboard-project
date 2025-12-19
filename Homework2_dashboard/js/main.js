// ===== 一些小工具函数 =====
function iso3ToCountryName(iso3) {
  const map = {
    TZA: "Tanzania",
    KEN: "Kenya",
    UGA: "Uganda",
    RWA: "Rwanda",
    BDI: "Burundi",
    ETH: "Ethiopia",
    ZAF: "South Africa",
    NAM: "Namibia",
    BWA: "Botswana",
    ZMB: "Zambia",
    ZWE: "Zimbabwe",
    MOZ: "Mozambique",
    AGO: "Angola"
  };
  return map[iso3] || iso3 || "Unknown";
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function rgbToHex({ r, g, b }) {
  return (
    "#" +
    [r, g, b]
      .map((v) => {
        const clamped = Math.max(0, Math.min(255, Math.round(v)));
        return clamped.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

function interpolateHexColor(startHex, endHex, t) {
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  return rgbToHex({
    r: lerp(start.r, end.r, t),
    g: lerp(start.g, end.g, t),
    b: lerp(start.b, end.b, t)
  });
}

// 从 WDPA CSV 生成所有公园的 meta 列表
function buildParksMetaFromCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];

  const headers = lines[0].split(",");
  const headerIndex = {};
  headers.forEach((h, i) => {
    headerIndex[h.replace(/^\uFEFF/, "").trim()] = i; // 去 BOM
  });

  // 如果还保留 9 个重点公园的 parks-data.js，这里合并“加料”信息；没有也没关系
  const customBySiteId = new Map();
  if (typeof PARKS_META !== "undefined") {
    PARKS_META.forEach((m) => {
      if (m.wdpa_site_id != null) {
        customBySiteId.set(String(m.wdpa_site_id), m);
      }
    });
  }

  // 和你在 mapshaper 里用的一样的“可旅游公园”筛选规则
  const tourismRegex =
    /National Park|National Reserve|Nature Reserve|Wildlife Reserve|Game Reserve|Conservation Area|Conservancy/i;

  function parseLine(line) {
    const cells = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const obj = {};
    Object.keys(headerIndex).forEach((key) => {
      const idx = headerIndex[key];
      const raw = cells[idx] || "";
      obj[key] = raw.replace(/^"|"$/g, "");
    });
    return obj;
  }

  const metaList = [];

  for (let i = 1; i < lines.length; i++) {
    const row = parseLine(lines[i]);
    const desig = row.DESIG_ENG || "";
    const cat = row.IUCN_CAT || "";

    // 按 type + IUCN 做一次筛选（和 GeoJSON 保持一致）
    if (!tourismRegex.test(desig)) continue;
    if (cat === "Ia" || cat === "Ib") continue;

    const siteId = String(row.SITE_ID);
    const iso3 = row.ISO3;

    const baseMeta = {
      id: siteId, // 以后全部用这个 id
      name: row.NAME_ENG || row.NAME || "(Unnamed)",
      localName: row.NAME || "",
      country: iso3ToCountryName(iso3),
      countryISO3: iso3,
      desigEng: desig,
      iucnCat: cat,
      area_km2: row.REP_AREA ? Number(row.REP_AREA) : null,
      statusYear: row.STATUS_YR ? Number(row.STATUS_YR) : null,
      govType: row.GOV_TYPE || row.MANG_AUTH || "Unknown",

      // 下面这些是给 9 个重点公园“加料”的字段，其它公园默认值即可
      visitors_2024: 0,
      predator_index: 0,
      has_big_five: false,
      in_migration_route: false,
      main_species: [],
      storymap_url: ""
    };

    const custom = customBySiteId.get(siteId);
    if (custom) {
      baseMeta.visitors_2024 = custom.visitors_2024 || 0;
      baseMeta.predator_index = custom.predator_index || 0;
      baseMeta.has_big_five = !!custom.has_big_five;
      baseMeta.in_migration_route = !!custom.in_migration_route;
      baseMeta.main_species = custom.main_species || [];
      baseMeta.storymap_url = custom.storymap_url || "";
    }

    metaList.push(baseMeta);
  }

  // 列表按国家 + 名称排序
  metaList.sort(
    (a, b) =>
      a.country.localeCompare(b.country) || a.name.localeCompare(b.name)
  );

  return metaList;
}

// ===== 页面入口：同时载入 GeoJSON + CSV =====
window.addEventListener("load", () => {
  const map = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    attributionControl: false
  }).setView([-2.1, 35.1], 7);

  L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(map);

  map.whenReady(() => map.invalidateSize());
  window.addEventListener("resize", () => map.invalidateSize());

  Promise.all([
    fetch("./data/parks.json").then((r) => r.json()), // 你的 GeoJSON（517 个公园）
    fetch("./data/WDPA_Dec2025_Public_AF_csv.csv").then((r) =>
      r.text()
    )
  ])
    .then(([parksGeojson, csvText]) => {
      const parksMeta = buildParksMetaFromCsv(csvText);
      initDashboard(map, parksGeojson, parksMeta);
    })
    .catch((err) => {
      console.error("Failed to load data:", err);
    });
});

// ===== Dashboard 主逻辑 =====
function initDashboard(map, parksGeojson, parksMeta) {
  const parksMetaById = new Map(parksMeta.map((m) => [m.id, m]));
  const parkLayersById = new Map();
  const parkCardElementsById = new Map();
  let activeParkId = null;
  let parksLayer;

  const statusYearsFromMeta = parksMeta
    .map((m) => m.statusYear)
    .filter((y) => typeof y === "number" && !Number.isNaN(y));
  const statusYearsFromGeojson = (parksGeojson.features || [])
    .map((f) => f?.properties?.STATUS_YR)
    .filter((y) => typeof y === "number" && !Number.isNaN(y));
  const statusYears = [...statusYearsFromMeta, ...statusYearsFromGeojson];
  const minStatusYear = statusYears.length
    ? Math.min(...statusYears)
    : null;
  const maxStatusYear = statusYears.length
    ? Math.max(...statusYears)
    : null;

    function getStatusYear(meta, feature) {
    const fromMeta = meta?.statusYear;
    if (typeof fromMeta === "number" && !Number.isNaN(fromMeta)) {
      return fromMeta;
    }
    const fromFeature = feature?.properties?.STATUS_YR;
    if (typeof fromFeature === "number" && !Number.isNaN(fromFeature)) {
      return fromFeature;
    }
    return null;
  }

  function colorByStatusYear(year) {
    if (!year || !minStatusYear || !maxStatusYear) return "#d6c5a5";
    if (minStatusYear === maxStatusYear) return "#5a2f12";
    const t = Math.max(
      0,
      Math.min(1, (year - minStatusYear) / (maxStatusYear - minStatusYear))
    );
    // older is darker
    const eased = Math.pow(t, 0.8);
    return interpolateHexColor("#faedcf", "#5a2f12", eased);
  }

  // DOM
  const sidebarEl = document.querySelector(".sidebar");
  const toggleSidebarBtn = document.getElementById("toggleSidebar");
  const parkListEl = document.getElementById("parkList");
  const parkDetailEl = document.getElementById("parkDetail");
  const searchInput = document.getElementById("searchInput");
  const filterRadios = document.querySelectorAll('input[name="filterMode"]');
  let currentFilterMode = "country";

  if (sidebarEl && toggleSidebarBtn) {
  toggleSidebarBtn.addEventListener("click", () => {
    const collapsed = sidebarEl.classList.toggle("sidebar-collapsed");
    setTimeout(() => {
      map.invalidateSize();
    }, 310);
  });
}

  // Map Info Popup
  let mapInfoPopup = null;

  const mapInfoControl = L.control({ position: "topright" });
  let mapInfoEl = null;

  mapInfoControl.onAdd = function () {
    const container = L.DomUtil.create("div", "map-info-box hidden");
    container.innerHTML = "<p>Click to get details</p>";
    L.DomEvent.disableClickPropagation(container);
    mapInfoEl = container;
    return container;
  };

  mapInfoControl.addTo(map);

  // ---- 选中公园（列表 + 地图联动）----
  function setActivePark(parkId) {
    if (activeParkId === parkId) return;

    // 1. 取消旧高亮
    if (activeParkId) {
      const oldLayer = parkLayersById.get(activeParkId);
      if (oldLayer && parksLayer) {
        parksLayer.resetStyle(oldLayer);
      }
      const oldCard = parkCardElementsById.get(activeParkId);
      if (oldCard) {
        oldCard.classList.remove("active");
      }
    }

    activeParkId = parkId;

    if (parkId) {
      const newLayer = parkLayersById.get(parkId);
      if (newLayer) {
        const meta = parksMetaById.get(parkId);
        newLayer.setStyle({
          color: "#F4A261",
          weight: 3,
          opacity: 1,
          fillColor: colorByStatusYear(getStatusYear(meta, newLayer.feature)),
          fillOpacity: 0.65
        });
        map.fitBounds(newLayer.getBounds(), { maxZoom: 8 });
      }

      const newCard = parkCardElementsById.get(parkId);
      if (newCard) {
        newCard.classList.add("active");
        newCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }

      const meta = parksMetaById.get(parkId);
      renderParkDetail(meta);
      renderMapInfo(meta);
    } else {
      renderParkDetail(null);
      renderMapInfo(null);
    }
  }

  // ---- 2.1 画所有公园多边形 ----
  const baseParkStyle = (meta, feature) => ({
    color: "#F47D85",
    weight: 1,
    opacity: 0.8,
    fillColor: colorByStatusYear(getStatusYear(meta, feature)),
    fillOpacity: 0.55
  });

  parksLayer = L.geoJSON(parksGeojson, {
    style: (feature) => {
      const parkId = String(feature.properties.SITE_ID || "");
      const meta = parksMetaById.get(parkId);
      return baseParkStyle(meta, feature);
    },
    onEachFeature: (feature, layer) => {
      const siteId = feature.properties.SITE_ID;
      if (!siteId) return;
      const parkId = String(siteId);

      if (!parksMetaById.has(parkId)) return;

      feature.properties.id = parkId;
      parkLayersById.set(parkId, layer);

      layer.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        setActivePark(parkId);
      });
    }
  }).addTo(map);

  // ---- 3. 右侧列表 + 详情面板 ----
  function createParkCardHtml(meta) {
    const tags = (meta.main_species || [])
      .map((s) => `<span class="tag">${s}</span>`)
      .join("");

    return `
      <div class="park-card" data-park-id="${meta.id}">
        <div class="park-card-title">${meta.name}</div>
        <div class="park-card-subtitle">
          ${meta.country} · ${meta.desigEng || ""}
        </div>
        <div class="tag-list">${tags}</div>
      </div>
    `;
  }

  function matchFilter(meta, mode, keyword) {
    if (!keyword) return true; // 没有关键字就不过滤
    keyword = keyword.toLowerCase();
    const name = (meta.name || "").toLowerCase();
    const country = (meta.country || "").toLowerCase();

    if (mode === "park") {
      return name.includes(keyword) || country.includes(keyword);
    }

     if (mode === "country") {
      return country.includes(keyword);
    }

    if (mode === "iucn") {
      return (meta.iucnCat || "").toLowerCase().includes(keyword);
    }
    return true;
}


  function renderParkList() {
    parkListEl.innerHTML = "";
    parkCardElementsById.clear();

    const keyword = searchInput.value.toLowerCase().trim();
    const filtered = parksMeta.filter((m) =>
      matchFilter(m, currentFilterMode, keyword)
    );

    if (!filtered.length) {
      parkListEl.innerHTML = "<p>No parks found with current filter.</p>";
      return;
    }

    filtered.forEach((meta) => {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = createParkCardHtml(meta).trim();
      const cardElement = tempDiv.firstChild;

      parkCardElementsById.set(meta.id, cardElement);

      cardElement.addEventListener("click", () => {
        setActivePark(meta.id);
      });

      if (meta.id === activeParkId) {
        cardElement.classList.add("active");
      }

      parkListEl.appendChild(cardElement);
    });
  }

  function renderParkDetail(meta) {
    if (!meta) {
      parkDetailEl.innerHTML =
        "<p>Select a park on the map or from the list.</p>";
      return;
    }

    const migrationTag = meta.in_migration_route
      ? '<span class="tag">On Migration Route</span>'
      : "";
    const bigFiveTag = meta.has_big_five
      ? '<span class="tag">Big Five Area</span>'
      : "";
    const mainSpecies = (meta.main_species || []).join(", ");

    parkDetailEl.innerHTML = `
      <h3>${meta.name}</h3>
      <p class="detail-subtitle">${meta.country}</p>
      <div class="tag-list detail-tags">
        ${migrationTag}
        ${bigFiveTag}
      </div>

      <div class="detail-stats">
        <p><strong>Type:</strong> ${meta.desigEng || "N/A"} (IUCN ${
      meta.iucnCat || "N/A"
    })</p>
        <p><strong>Reported area:</strong> ${
          meta.area_km2 ? meta.area_km2.toLocaleString() + " km²" : "N/A"
        }</p>
        <p><strong>Year established:</strong> ${
          meta.statusYear || "N/A"
        }</p>
        <p><strong>Manager:</strong> ${meta.govType || "N/A"}</p>
        ${
          mainSpecies
            ? `<p><strong>Key Species:</strong> ${mainSpecies}</p>`
            : ""
        }
      </div>

      ${
        meta.storymap_url
          ? `<p class="storymap-link-hint">Check out the interactive story map:</p>`
          : "<p class='storymap-link-hint'>No dedicated story map available.</p>"
      }
      <button class="storymap-btn" ${
        meta.storymap_url ? "" : "disabled"
      } onclick="${
      meta.storymap_url ? `window.open('${meta.storymap_url}', '_blank')` : ""
    }">
        ${meta.storymap_url ? "Open Story Map" : "Story Map Unavailable"}
      </button>
    `;
  }

  function renderMapInfo(meta) {
    if (mapInfoPopup) {
    map.removeLayer(mapInfoPopup);
    mapInfoPopup = null;
  }
    if (!meta) return;
  const layer = parkLayersById.get(meta.id);
  if (!layer) return;

  const bounds = layer.getBounds();
  const center = bounds.getCenter();

  const labelLatLng = L.latLng(center.lat, bounds.getEast());

  mapInfoPopup = L.popup({
    closeButton: false,
    autoPan: false,         
    offset: [10, 0],       
    className: "map-inline-popup"
  })
    .setLatLng(labelLatLng)
    .setContent(
      `<div class="map-info-title">${meta.name}</div>
       <div class="map-info-subtitle">${meta.country}</div>`
    )
    .addTo(map);
}

  // ---- 4. 事件绑定 ----
  searchInput.addEventListener("input", renderParkList);
  filterRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      currentFilterMode = radio.value;
      renderParkList();
    });
  });

  renderParkList();
}