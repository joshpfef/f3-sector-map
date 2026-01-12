// ====== CONFIG ======
const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRPBsOPUCOUUkJC-RBOgFWltIh39gy8Sg0YAmMXkozQ5hK15z403r7CVx50NGmQOCy5-ib25BW1mfss/pub?gid=0&single=true&output=csv";

// US States GeoJSON (includes Puerto Rico sometimes; we’ll ignore non-states gracefully)
const US_STATES_GEOJSON_URL =
  "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/us-states.json";

// ====== HELPERS ======
function parseCSV(text) {
  // Minimal CSV parser that handles quoted commas
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') {
      cur += '"'; i++;
    } else if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(cur.trim());
      cur = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (cur.length || row.length) {
        row.push(cur.trim());
        rows.push(row);
        row = [];
        cur = "";
      }
      // swallow \r\n
      if (c === "\r" && next === "\n") i++;
    } else {
      cur += c;
    }
  }
  if (cur.length || row.length) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rows;
}

function normalizeStateAbbrev(s) {
  return (s || "").trim().toUpperCase();
}

function safe(v) {
  return (v ?? "").toString().trim();
}

function buildSectorCard(sector) {
  const photo = safe(sector.sector_q_photo_url);
  const email = safe(sector.sector_q_email);
  const phone = safe(sector.sector_q_phone);

  const emailLine = email ? `<div><span class="muted">Email:</span> ${escapeHTML(email)}</div>` : "";
  const phoneLine = phone ? `<div><span class="muted">Phone:</span> ${escapeHTML(phone)}</div>` : "";

  return `
    <div class="sector-card">
      <div>
        ${
          photo
            ? `<img src="${escapeAttr(photo)}" alt="Sector Q" />`
            : `<img src="data:image/svg+xml;charset=utf8,${encodeURIComponent(
                `<svg xmlns='http://www.w3.org/2000/svg' width='72' height='72'>
                  <rect width='100%' height='100%' fill='#eee'/>
                  <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'
                        font-family='Arial' font-size='12' fill='#888'>No photo</text>
                </svg>`
              )}" alt="No photo" />`
        }
      </div>
      <div>
        <h3>${escapeHTML(safe(sector.sector_name))} <span class="muted">(${escapeHTML(safe(sector.sector_id))})</span></h3>
        <div class="meta">
          <div><span class="muted">Sector Q:</span> ${escapeHTML(safe(sector.sector_q_f3_name))}${sector.sector_q_real_name ? ` <span class="muted">/</span> ${escapeHTML(safe(sector.sector_q_real_name))}` : ""}</div>
          ${emailLine}
          ${phoneLine}
        </div>
      </div>
    </div>
  `;
}

function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[m]);
}
function escapeAttr(str) {
  return escapeHTML(str).replace(/"/g, "&quot;");
}

function hashToHsl(str) {
  // stable-ish coloring by sector_id
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 65;
  const light = 55;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// ====== MAIN ======
(async function main() {
  // Map init
  const map = L.map("map", { zoomSnap: 0.25 }).setView([39.5, -98.35], 4);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 10,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // Load sheet data
  const sheetResp = await fetch(GOOGLE_SHEET_CSV_URL, { cache: "no-store" });
  if (!sheetResp.ok) throw new Error("Failed to load Google Sheet CSV. Check publish settings/URL.");
  const csvText = await sheetResp.text();
  const rows = parseCSV(csvText);
  const headers = rows.shift().map(h => h.trim());

  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  // State -> sector row
  const stateToSector = new Map();
  // Sector id -> sector info (for sector-hover behavior)
  const sectorById = new Map();

  for (const r of rows) {
    const state = normalizeStateAbbrev(r[idx.state]);
    if (!state) continue;

    const sector = {
      state,
      sector_id: safe(r[idx.sector_id]),
      sector_name: safe(r[idx.sector_name]),
      sector_q_f3_name: safe(r[idx.sector_q_f3_name]),
      sector_q_real_name: safe(r[idx.sector_q_real_name]),
      sector_q_email: safe(r[idx.sector_q_email]),
      sector_q_phone: safe(r[idx.sector_q_phone]),
      sector_q_photo_url: safe(r[idx.sector_q_photo_url]),
    };

    stateToSector.set(state, sector);
    if (sector.sector_id && !sectorById.has(sector.sector_id)) {
      sectorById.set(sector.sector_id, sector);
    }
  }

  // Load GeoJSON states
  const geoResp = await fetch(US_STATES_GEOJSON_URL, { cache: "force-cache" });
  if (!geoResp.ok) throw new Error("Failed to load US states GeoJSON.");
  const statesGeo = await geoResp.json();

  // Keep track of layers by sector for sector-hover highlighting
  const sectorLayers = new Map(); // sector_id -> Set(layer)

  function baseStyleForSector(sectorId) {
    const fill = sectorId ? hashToHsl(sectorId) : "rgba(200,200,200,0.45)";
    return {
      weight: 1,
      color: "rgba(255,255,255,0.85)",
      fillColor: fill,
      fillOpacity: 0.75
    };
  }

  function setSectorHighlight(sectorId, on) {
    const layers = sectorLayers.get(sectorId);
    if (!layers) return;
    layers.forEach(layer => {
      const st = baseStyleForSector(sectorId);
      layer.setStyle({
        ...st,
        weight: on ? 3 : st.weight,
        color: on ? "rgba(0,0,0,0.65)" : st.color,
        fillOpacity: on ? 0.9 : st.fillOpacity
      });
      if (on) layer.bringToFront();
    });
  }

  const geoLayer = L.geoJSON(statesGeo, {
    style: (feature) => {
      const name = (feature.properties.name || "").trim();
      // This GeoJSON uses full state names, not abbreviations.
      // We'll translate full name -> abbrev using a small map below.
      const abbrev = STATE_NAME_TO_ABBREV[name] || "";
      const sector = stateToSector.get(abbrev);
      const sectorId = sector?.sector_id || "";
      return baseStyleForSector(sectorId);
    },
    onEachFeature: (feature, layer) => {
      const name = (feature.properties.name || "").trim();
      const abbrev = STATE_NAME_TO_ABBREV[name] || "";
      const sector = stateToSector.get(abbrev);

      const sectorId = sector?.sector_id || "";
      if (sectorId) {
        if (!sectorLayers.has(sectorId)) sectorLayers.set(sectorId, new Set());
        sectorLayers.get(sectorId).add(layer);
      }

      // Tooltip content: sector card (same for all states in sector)
      const tooltipHTML = sectorId && sectorById.get(sectorId)
        ? buildSectorCard(sectorById.get(sectorId))
        : `<div style="padding:10px; font-family:system-ui,Segoe UI,Roboto,Arial; font-size:13px;">
             <b>${escapeHTML(name)}</b><br/>
             <span class="muted">No sector assigned</span>
           </div>`;

      layer.bindTooltip(tooltipHTML, {
        className: "sector-tooltip",
        direction: "auto",
        sticky: true,
        opacity: 1
      });

      layer.on("mouseover", () => {
        if (sectorId) setSectorHighlight(sectorId, true);
      });
      layer.on("mouseout", () => {
        if (sectorId) setSectorHighlight(sectorId, false);
      });
    }
  }).addTo(map);

  // Fit to US bounds
  map.fitBounds(geoLayer.getBounds(), { padding: [10, 10] });
})().catch(err => {
  console.error(err);
  alert(err.message || "Error loading map.");
});

// Full name -> abbreviation map for the GeoJSON source we used
const STATE_NAME_TO_ABBREV = {
  "Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO","Connecticut":"CT",
  "Delaware":"DE","Florida":"FL","Georgia":"GA","Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA",
  "Kansas":"KS","Kentucky":"KY","Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI",
  "Minnesota":"MN","Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH",
  "New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH","Oklahoma":"OK",
  "Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD","Tennessee":"TN",
  "Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA","Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY"
};
