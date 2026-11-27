/**
 * One region as a map, for the phone page's region view (the alternative to the grid of cards):
 * each country a tiny card where the map puts it, and its neighbours joined by lines.
 *
 * The map's regions are of every shape -- Europe twice as wide as it is tall, Africa and South
 * America tall -- and the phone is held upright. So a region is fitted to the page's width and laid
 * out as tall as it needs: its countries' map positions (rules/map.json `pos`) are scaled to the
 * width, stretched downwards, then pushed apart until no two cards overlap (mostly up and down, as
 * the width is fixed). The layout is computed once per region and is the same on every phone.
 */
import { MAP_METADATA } from "../metadata";

/** The layout's own units: CSS pixels of a card and of the width the region is fitted to. */
export const MAP_W = 340;
export const CARD_W = 50;
export const CARD_H = 34;
const GAP = 12;
/** The tallest a region is laid out before its cards are pushed apart. */
const MAX_H = 200;

/** A country's name in two or three letters (country codes where the players know them), for a
 *  card a seventh of a phone wide; the full name is the card's title and its details sheet. */
export const ABBR: Record<string, string> = {
  "Canada": "CA", "United Kingdom": "UK", "Norway": "NO", "Sweden": "SE", "Denmark": "DK", "Finland": "FI",
  "Benelux": "BNL", "West Germany": "WG", "France": "FR", "Spain/Portugal": "SP", "Italy": "IT", "Greece": "GR",
  "Turkey": "TR", "Austria": "AT", "East Germany": "EG", "Poland": "PL", "Czechoslovakia": "CZ", "Hungary": "HU",
  "Yugoslavia": "YU", "Romania": "RO", "Bulgaria": "BG",
  "Lebanon": "LB", "Syria": "SY", "Israel": "IL", "Iraq": "IQ", "Iran": "IR", "Jordan": "JO", "Gulf States": "GS",
  "Saudi Arabia": "SA", "Egypt": "EGY", "Libya": "LY",
  "Afghanistan": "AF", "Pakistan": "PK", "India": "IN", "Burma": "BUR", "Laos/Cambodia": "LC", "Thailand": "TH",
  "Vietnam": "VN", "Malaysia": "MY", "Indonesia": "ID", "Philippines": "PH", "Australia": "AU", "Taiwan": "TW",
  "North Korea": "NK", "South Korea": "SK", "Japan": "JP",
  "Morocco": "MA", "Algeria": "ALG", "Tunisia": "TUN", "West African States": "WAS", "Saharan States": "SAH",
  "Sudan": "SUD", "Ivory Coast": "IC", "Nigeria": "NIG", "Ethiopia": "ETH", "Somalia": "SOM", "Cameroon": "CAM",
  "Zaire": "ZAI", "Kenya": "KEN", "Angola": "ANG", "Zimbabwe": "ZIM", "SE African States": "SEA", "Botswana": "BOT",
  "South Africa": "SAF",
  "Mexico": "MX", "Guatemala": "GU", "El Salvador": "ES", "Honduras": "HO", "Costa Rica": "CR", "Nicaragua": "NI",
  "Panama": "PA", "Cuba": "CU", "Haiti": "HA", "Dominican Rep": "DR",
  "Colombia": "CO", "Ecuador": "EC", "Peru": "PE", "Venezuela": "VE", "Bolivia": "BO", "Brazil": "BR",
  "Paraguay": "PY", "Chile": "CL", "Argentina": "AR", "Uruguay": "UY",
};

export interface MapSpot {
  id: number;
  /** The card's top left corner, in layout units. */
  x: number;
  y: number;
}

/** A superpower beside some of the region's countries: a node in a band above the region. */
export interface SuperpowerSpot {
  side: "US" | "USSR";
  x: number;
  y: number;
  /** The countries beside it. */
  ids: number[];
}

/** A superpower node's size, in layout units. */
export const SP_W = 44;
export const SP_H = 20;
/** The band above the region the superpowers sit in. */
const SP_BAND = SP_H + 22;

export interface RegionMap {
  spots: MapSpot[];
  superpowers: SuperpowerSpot[];
  height: number;
  /** Neighbouring pairs within the region. */
  links: Array<[number, number]>;
  /** Neighbours outside the region, by country: their names, for a tag on the card's edge. */
  away: Map<number, string[]>;
}

const cache = new Map<string, RegionMap>();

/** Whether the segment from (ax, ay) to (bx, by) passes through card `r` (Liang-Barsky). */
function crosses(ax: number, ay: number, bx: number, by: number, r: { x: number; y: number }, w = CARD_W, h = CARD_H): boolean {
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  const edges: Array<[number, number]> = [[-dx, ax - r.x], [dx, r.x + w - ax], [-dy, ay - r.y], [dy, r.y + h - ay]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 < t1;
}

/** How much taller than the map's own proportion a region is laid out, before the cards are pushed
 *  apart: the wide regions need room to stack. */
const STRETCH: Record<string, number> = {
  "Europe": 1.3, "Middle East": 1.1, "Asia": 1.1, "Africa": 1.0, "Central America": 1.6, "South America": 1.0,
};

export function regionMap(region: string): RegionMap {
  const hit = cache.get(region);
  if (hit) return hit;
  const cs = MAP_METADATA.countries.filter(c => c.region === region && c.pos);
  const xs = cs.map(c => c.pos![0]), ys = cs.map(c => c.pos![1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys);
  const sx = (MAP_W - CARD_W) / Math.max(1, x1 - x0);
  // Downwards, the map's proportion stretched -- but never taller than MAX_H before the cards are
  // pushed apart: a tall, narrow region (South America) scaled to the width would be mostly gaps.
  const y1 = Math.max(...ys);
  const sy = Math.min(sx * (STRETCH[region] ?? 1.5), MAX_H / Math.max(1, y1 - y0));
  // Across, a country's place blends where the map puts it with its rank from the left: an outlier
  // (Canada, far west of Europe) would otherwise squeeze the rest into a column.
  const rank = new Map([...cs].sort((a, b) => a.pos![0] - b.pos![0]).map((c, i) => [c.id, i / Math.max(1, cs.length - 1)]));
  const spots: MapSpot[] = cs.map(c => ({
    id: c.id,
    x: 0.4 * (c.pos![0] - x0) * sx + 0.6 * rank.get(c.id)! * (MAP_W - CARD_W),
    y: (c.pos![1] - y0) * sy,
  }));

  // Push overlapping cards apart, each by half the overlap, along the shorter way out -- but never
  // sideways past the width, so a crowded row turns into a column.
  const w = CARD_W + GAP, h = CARD_H + GAP;
  for (let it = 0; it < 400; it++) {
    let moved = false;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i], b = spots[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = w - Math.abs(dx), oy = h - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Sideways only when that is clearly shorter: the page grows down, not across.
        if (ox * 1.6 < oy) {
          const s = (dx >= 0 ? 1 : -1) * ox / 2;
          a.x -= s; b.x += s;
        } else {
          const s = (dy >= 0 ? 1 : -1) * oy / 2;
          a.y -= s; b.y += s;
        }
      }
    }
    for (const p of spots) p.x = Math.min(MAP_W - CARD_W, Math.max(0, p.x));
    if (!moved) break;
  }
  const top = Math.min(...spots.map(p => p.y));
  for (const p of spots) { p.x = Math.round(p.x); p.y = Math.round(p.y - top); }

  const byName = new Map(MAP_METADATA.countries.map(c => [c.name, c]));
  const inRegion = new Set(cs.map(c => c.id));
  const links: Array<[number, number]> = [];
  const away = new Map<number, string[]>();
  for (const c of cs) {
    for (const n of c.neighbours) {
      const o = byName.get(n);
      if (!o) continue;
      if (inRegion.has(o.id)) { if (c.id < o.id) links.push([c.id, o.id]); }
      else away.set(c.id, [...(away.get(c.id) ?? []), ABBR[o.name] ?? o.name]);
    }
  }
  const at = new Map(spots.map(p => [p.id, p]));
  // The superpowers: each where its lines to the countries beside it are shortest without passing
  // behind another card -- a gap among the cards (the USSR between Finland, Poland and Romania) or
  // a band above them (the USSR over Afghanistan and North Korea).
  const superpowers: SuperpowerSpot[] = [];
  const bottom = Math.max(...spots.map(p => p.y)) + CARD_H;
  for (const [side, key] of [["US", "USA"], ["USSR", "USSR"]] as const) {
    const ids = cs.filter(c => c.superpower_adjacent === key).map(c => c.id);
    if (!ids.length) continue;
    let best: { x: number; y: number; score: number } | null = null;
    for (let y = -SP_BAND; y <= bottom - SP_H; y += 4) {
      for (let x = 0; x <= MAP_W - SP_W; x += 4) {
        const clear = (r: { x: number; y: number }, w: number, h: number) =>
          x + SP_W + 4 <= r.x || r.x + w + 4 <= x || y + SP_H + 4 <= r.y || r.y + h + 4 <= y;
        if (!spots.every(p => clear(p, CARD_W, CARD_H)) || !superpowers.every(o => clear(o, SP_W, SP_H))) continue;
        let score = y < 0 ? 30 : 0;   // the band costs the region some height
        // Not on top of a neighbour line.
        const node = { x, y };
        for (const [a, b] of links) {
          const p = at.get(a)!, q = at.get(b)!;
          if (crosses(p.x + CARD_W / 2, p.y + CARD_H / 2, q.x + CARD_W / 2, q.y + CARD_H / 2, node, SP_W, SP_H)) score += 300;
        }
        for (const id of ids) {
          const q = at.get(id)!;
          const ax = x + SP_W / 2, ay = y + SP_H / 2, bx = q.x + CARD_W / 2, by = q.y + CARD_H / 2;
          const len = Math.hypot(bx - ax, by - ay);
          // Long enough to be seen between the node and the card (they are about 40 apart edge to centre).
          score += len + Math.max(0, 75 - len) * 6;
          for (const o of spots) if (o.id !== id && crosses(ax, ay, bx, by, o)) score += 400;
        }
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    if (best) superpowers.push({ side, ids, x: best.x, y: best.y });
  }
  const band = superpowers.some(sp => sp.y < 0) ? SP_BAND : 0;
  for (const p of spots) p.y += band;
  for (const sp of superpowers) sp.y += band;
  const height = Math.max(...spots.map(p => p.y)) + CARD_H;

  const out = { spots, superpowers, height, links, away };
  cache.set(region, out);
  return out;
}
