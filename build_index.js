// Genera data/activaciones.json: índice de activaciones Copernicus EMS Rapid Mapping (EMSR) en España.
// Uso: node build_index.js
// Las APIs de CEMS no envían cabeceras CORS, así que el navegador no puede consultarlas
// directamente: este script se ejecuta en local o en GitHub Actions y deja el índice estático.
import { mkdir, writeFile, readFile } from "node:fs/promises";

const API_LISTA = "https://mapping.emergency.copernicus.eu/activations/api/activations/";
const API_DETALLE = "https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/";
const SALIDA = new URL("./data/activaciones.json", import.meta.url);
const CONCURRENCIA = 4;

const espera = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, intentos = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (r.status === 403 || r.status === 404) return { _status: r.status };
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (i >= intentos) throw new Error(`${url}: ${e.message}`);
      await espera(1500 * i);
    }
  }
}

// --- WKT -> geometría GeoJSON (solo POINT / POLYGON / MULTIPOLYGON, que es lo que devuelve la API) ---
const red = n => Math.round(parseFloat(n) * 1e5) / 1e5;
const anillo = s => s.split(",").map(p => p.trim().split(/\s+/).slice(0, 2).map(red));
const anillos = s => [...s.matchAll(/\(([^()]+)\)/g)].map(m => anillo(m[1]));
function wkt(s) {
  if (!s) return null;
  const t = s.trim();
  if (/^POINT/i.test(t)) return t.match(/\(([^)]+)\)/)[1].trim().split(/\s+/).map(red);
  if (/^POLYGON/i.test(t)) return { type: "Polygon", coordinates: anillos(t) };
  if (/^MULTIPOLYGON/i.test(t)) {
    const polis = [...t.matchAll(/\(\s*(\([^()]+\)(?:\s*,\s*\([^()]+\))*)\s*\)/g)].map(m => anillos(m[1]));
    return { type: "MultiPolygon", coordinates: polis };
  }
  return null;
}

function resumirProducto(p, bucket) {
  const capas = p.layers || [];
  return {
    type: p.type,
    monitoring: !!p.monitoring,
    monitoringNumber: p.monitoringNumber || 0,
    feasible: p.feasible,
    status: p.version?.statusCode ?? null,
    version: p.version?.number ?? null,
    versionReason: p.version?.reason || "",
    deliveryTime: p.version?.deliveryTime ?? null,
    expectedDelivery: p.expectedDelivery ?? null,
    mapsCount: p.mapsCount ?? null,
    downloadPath: p.downloadPath || null,
    images: (p.images || []).map(im => ({
      sensorName: im.sensorName,
      sensorType: im.sensorType,
      resolutionClass: im.resolutionClass,
      acquisitionTime: im.acquisitionTime,
      fileName: im.fileName,
      new: im.new,
    })),
    cogs: capas.filter(l => l.format === "cog").map(l => `${bucket}/${l.name}`),
    vectors: capas.filter(l => l.json).map(l => ({
      name: (l.name.match(/_([A-Za-z]+)_v\d+_VT$/) || [, l.name.split("/").pop()])[1],
      json: l.json,
    })),
  };
}

async function main() {
  // countries=ES filtra en servidor (ojo: "ESP" o "Spain" devuelven 0); se filtra además en cliente por si cambia.
  const lista = await fetchJSON(`${API_LISTA}?countries=ES&limit=2000`);
  const emsr = lista.results
    .filter(a => /^EMSR\d+/.test(a.code) && a.countries.some(c => c.short_name === "Spain"))
    .sort((a, b) => b.activationTime.localeCompare(a.activationTime));
  console.log(`Activaciones EMSR con España: ${emsr.length}`);

  const out = new Array(emsr.length);
  let siguiente = 0;
  async function trabajador() {
    while (siguiente < emsr.length) {
      const i = siguiente++;
      const a = emsr[i];
      const base = {
        code: a.code,
        name: a.name,
        category: a.category?.name || null,
        categorySlug: a.category?.slug || null,
        activationTime: a.activationTime,
        lastUpdate: a.lastUpdate,
        closed: a.closed,
        countries: a.countries.map(c => c.short_name),
        centroid: wkt(a.centroid),
        nAois: a.n_aois,
        nProducts: a.n_products,
        summary: a.search_snippet || "",
        detail: false,
      };
      const d = await fetchJSON(`${API_DETALLE}?code=${a.code}`);
      const det = d.results?.[0];
      if (det) {
        const bucket = det.aws_bucket || "https://rapidmapping-viewer.s3.eu-west-1.amazonaws.com";
        Object.assign(base, {
          detail: true,
          closed: det.closed,
          subCategory: det.subCategory || null,
          activator: det.activator || null,
          reason: det.reason || base.summary,
          eventTime: det.eventTime,
          reportLink: det.reportLink || null,
          gdacsId: det.gdacsId || null,
          charterNumber: det.charterNumber || null,
          charterUrl: det.charterUrl || null,
          stats: det.stats || null,
          productsPath: det.productsPath || null,
          extent: wkt(det.extent),
          aois: (det.aois || []).sort((x, y) => x.number - y.number).map(o => ({
            number: o.number,
            name: o.name,
            extent: wkt(o.extent),
            blpPath: o.blpPath || null,
            products: (o.products || []).map(p => resumirProducto(p, bucket)),
          })),
        });
      } else {
        base.detailStatus = d._status || "vacío";
      }
      out[i] = base;
      console.log(`${a.code} ${det ? "ok " + base.aois.length + " AOIs" : "sin detalle (" + base.detailStatus + ")"}`);
      await espera(150);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));

  // Si una activación que antes tenía detalle falla ahora de forma transitoria, se conserva el detalle previo.
  try {
    const previo = JSON.parse(await readFile(SALIDA, "utf8"));
    const porCodigo = new Map(previo.activations.map(a => [a.code, a]));
    out.forEach((a, i) => {
      const ant = porCodigo.get(a.code);
      if (!a.detail && ant?.detail) out[i] = { ...ant, lastUpdate: a.lastUpdate };
    });
  } catch {}

  await mkdir(new URL("./data/", import.meta.url), { recursive: true });
  const json = JSON.stringify({ generated: new Date().toISOString(), activations: out });
  await writeFile(SALIDA, json);
  // Copia como script para poder abrir index.html directamente desde disco (file://), donde fetch no funciona.
  await writeFile(new URL("./data/activaciones.js", import.meta.url), `window.ACTIVACIONES=${json};`);
  const con = out.filter(a => a.detail).length;
  console.log(`Escrito data/activaciones.json: ${out.length} activaciones (${con} con detalle, ${out.length - con} sin él)`);
}

main().catch(e => { console.error(e); process.exit(1); });
